## 1. Inbox disabled but provider call starts

Rule broken: A disabled inbox must not start a new provider call after disable completes.
Why: Disabled inbox starts a provider call.
In the model, one step leads into this bug: "Call email provider using the earlier read". The steps below are the shortest path that TLC found.

0. Start: Inbox enabled; Queued for a worker; pending; accepted 0
1. Worker claims queued request. Now: Inbox enabled; Worker claimed request; sending; accepted 0
2. Read whether inbox is enabled. Now: Inbox enabled; Earlier check said inbox enabled; sending; accepted 0
3. Admin disables inbox. Now: Inbox disabled; Earlier check said inbox enabled; sending; accepted 0
4. Call email provider using the earlier read. Now: Inbox disabled but provider call starts

## 2. Outcome unknown but old worker starts sending

Rule broken: A stale worker must not start a new provider call after Cron declares its outcome unknown.
Why: Stale worker starts a provider call.
In the model, one step leads into this bug: "Call email provider using the earlier read". The steps below are the shortest path that TLC found.

0. Start: Inbox enabled; Queued for a worker; pending; accepted 0
1. Worker claims queued request. Now: Inbox enabled; Worker claimed request; sending; accepted 0
2. Cron marks stale request outcome unknown. Now: Inbox enabled; Worker claimed request; unknown; accepted 0
3. Read whether inbox is enabled. Now: Inbox enabled; Earlier check said inbox enabled; unknown; accepted 0
4. Call email provider using the earlier read. Now: Outcome unknown but old worker starts sending

## 3. Outcome unknown but old worker starts sending

Rule broken: A disabled inbox must not start a new provider call after disable completes.
Why: Disabled inbox starts a provider call; Stale worker starts a provider call.
In the model, one step leads into this bug: "Call email provider using the earlier read". The steps below are the shortest path that TLC found.

0. Start: Inbox enabled; Queued for a worker; pending; accepted 0
1. Worker claims queued request. Now: Inbox enabled; Worker claimed request; sending; accepted 0
2. Cron marks stale request outcome unknown. Now: Inbox enabled; Worker claimed request; unknown; accepted 0
3. Read whether inbox is enabled. Now: Inbox enabled; Earlier check said inbox enabled; unknown; accepted 0
4. Admin disables inbox. Now: Inbox disabled; Earlier check said inbox enabled; unknown; accepted 0
5. Call email provider using the earlier read. Now: Outcome unknown but old worker starts sending

## 4. Outcome unknown but old worker starts sending

Rule broken: A stale worker must not start a new provider call after Cron declares its outcome unknown.
Why: Disabled inbox starts a provider call; Stale worker starts a provider call.
In the model, one step leads into this bug: "Call email provider using the earlier read". The steps below are the shortest path that TLC found.

0. Start: Inbox enabled; Queued for a worker; pending; accepted 0
1. Worker claims queued request. Now: Inbox enabled; Worker claimed request; sending; accepted 0
2. Cron marks stale request outcome unknown. Now: Inbox enabled; Worker claimed request; unknown; accepted 0
3. Read whether inbox is enabled. Now: Inbox enabled; Earlier check said inbox enabled; unknown; accepted 0
4. Admin disables inbox. Now: Inbox disabled; Earlier check said inbox enabled; unknown; accepted 0
5. Call email provider using the earlier read. Now: Outcome unknown but old worker starts sending
