# 送信処理の形式検証

2026-10-25に、プロダクトのコミット`ed15d43123471a7de7c89be7f77f5380da136dc9`を調査した。
[pstackのcreate-formal-verification-skill](https://github.com/cursor/plugins/blob/9580c23696ac8d7abed0c166f2f9918800afb819/pstack/skills/create-formal-verification-skill/SKILL.md)に従い、TLA+と`tlaplus/tlaplus v1.7.4`に含まれるTLC 2.19で操作の順序をモデル検査し、実コードで反例を再現した。
調査であり、プロダクトコードは変更していない。既存の通常CIが通ることと、今回の形式検証に反例があることは両立する。

## 結果

| 性質                                                          | TLC（最大8 claim） | 実コード                                                 |
| ------------------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| 同じoutbox要求をプロバイダーが2回受理しない                   | 反例なし           | 重複ジョブで呼び出し1回                                  |
| 結果不明になった要求を新たにclaimして自動再試行しない         | 反例なし           | 従来のunknown再送防止テストに加え、claimの変異検査を実施 |
| 無効化完了後は新しいプロバイダー呼び出しを開始しない          | 反例あり           | APIで無効化後に呼び出し1回、outboxはaccepted             |
| Cronでunknown化した後は古いWorkerが新しく呼び出しを開始しない | 反例あり           | 3分の遅延を注入すると呼び出し1回、outboxはunknownのまま  |

下の2件は「開始済みの外部通信を取り消せない」という話ではなく、状態変更が完了した後に外部呼び出しを**開始する**競合である。
ただし「claim済みの要求は無効化後も継続してよい」という仕様なら、1件目は停止保証の仕様整理が必要な制約になる。無効化を即時の送信停止スイッチとして使う場合には修正対象。
2件目はWorkerが2分以上遅延してから再開できるという条件付きの結果で、本番でその遅延が起きたことを示すものではない。

## F1: 有効状態を読んだ後の無効化を送信開始が見落とす

1. QueueのWorkerが`pending → sending`をclaimする。
2. `deliver`が`inboxes.active = 1`を読み取る。
3. 管理者のPATCHが`active = 0`を書き込み、200を返す。
4. Workerが手元の読み取り結果を使い、初めてプロバイダーを呼ぶ。

原因は[src/outbound.ts](../src/outbound.ts)の`deliver`が有効状態のSELECTと送信開始を別々に行うこと。無効化のUPDATEとは排他になっていない。
ローカルの実D1でSELECT完了直後にWorkerを止め、管理APIの成功を確認してから再開すると、プロバイダーのスタブが1回呼ばれ、管理APIから見えるoutboxも`accepted`になる。

![無効化後の送信開始](../verification/outbound/evidence/bug-1.png)

無効化完了を送信停止の境界にするなら、無効化と送信開始を同じ単位で直列化する設計が必要。送信直前にSELECTを一度追加するだけでは、そのSELECTと外部呼び出しの間に同じ競合が残る。

## F2: Cronのunknown化は遅延中のWorkerを停止しない

1. Workerが要求をclaimするが、有効状態のSELECTへ進む前に遅延する。
2. 2分を超えてからCronが`outbox.status = unknown`へ更新する。
3. Workerが再開し、有効な受信箱を読む。
4. Workerがプロバイダーを初めて呼ぶ。プロバイダーが受理しても、結果保存の`WHERE status = 'sending'`に一致せず、outboxはunknownのままになる。

実D1を使い、Workerの実行を止めて時計を3分進め、実際の`maintain`を呼び出してから再開すると再現する。直接unknownを書き込む偽の復旧処理ではない。
時計とスケジューリングはテストが制御している。Cloudflare実環境での発生頻度や各APIの実際の遅延上限は検証していない。

![unknown化後の送信開始](../verification/outbound/evidence/bug-2.png)

同じoutbox IDの自動再claimや二重送信を今回確認したわけではない。しかし、unknown化した時点で「古いWorkerはもう送らない」とは判断できない。未送信と照合して別のキーで再送する運用では、古い実行が今後進まないことも確認する必要がある。
試行の識別・実行の停止と復旧の同期を設計し、外部APIに冪等性契約がないという制約も含めて扱う必要がある。

## 検証範囲と仮定

一つの受信箱・一つのoutbox、Queueの実行主体2つ、最大8 claimまで。429のバックオフは「時刻が来れば再開可能」という順序の抽象化で、指数バックオフの数値自体の証明ではない。
配備設定のQueue同時実行数は1だが、重複配信・停止と再開に対してより強い側として2主体で検査した。F1とF2はいずれも1主体だけで成立する。

- 各D1 SQL文は原子的。SELECT、外部送信、UPDATEを一つの原子操作にはまとめていない。
- 429と明確な拒否はプロバイダー未受理。unknownの応答やWorker停止では、受理された可能性も含めた。
- Cronの反例ではWorkerの待機・再開に2分未満という上限を仮定していない。D1やWorkerのサービス側の時間保証をモデルへ追加するときは、その根拠と適用範囲を記録する。
- ライブネス、公平性、配達完了、D1復元、暗号、認証、MIME、イベント再生、システム全体のバグ不在は証明していない。

コードとの対応は[開発用スキル](../.agents/skills/verify-outbound-safety/SKILL.md)、モデルは[Outbound.tla](../verification/outbound/Outbound.tla)、反例再現は[replay.test.ts](../verification/outbound/replay.test.ts)。製品コードのコピーで反例を作ったのではなく、元の`deliver`・API・D1・復旧処理を呼び、外部プロバイダーだけをスタブにした。

## 再実行

```sh
mise install java github:tlaplus/tlaplus
mise exec -- bun install --frozen-lockfile
mise run verify:outbound
mise run verify:outbound:selftest
```

`verify:outbound`は現在、反例2件と実コードの失敗2件を報告して終了コード1になる。ツールの起動失敗として扱わない。証拠は`.verification/outbound/`に生成する。
`selftest`は、条件付きclaimのガードを壊したモデルと、同じガードを除いた実コードの一時コピーの両方で失敗を検出した場合に成功する。元のプロダクトファイルは変更しない。

図はpstack `/statechart`で最大2 claimの別設定を検査して生成し、全PNGの番号付き経路を目視確認した。生成手順は同スキルの現行手順を読み、[Outbound.chart.cfg](../verification/outbound/Outbound.chart.cfg)と[ラベル](../verification/outbound/Outbound.map.mjs)を使う。
[summary.json](../verification/outbound/evidence/summary.json)と[stories.md](../verification/outbound/evidence/stories.md)を保存した。経路3・4はF1とF2が重なる経路であり、独立した追加の不具合として数えていない。

コード変更後にモデルの対応が未確認なら、pstack `/maintain-formal-verification-skill`で同期を点検する。次の対象候補は受信原文の保存とD1索引修復の間の復旧手順。
