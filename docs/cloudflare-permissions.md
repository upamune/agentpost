# Cloudflare permissions

[English](cloudflare-permissions.md) | [日本語](cloudflare-permissions.ja.md)

Keep deployment credentials separate from the credentials used by agents and by the running Worker. A private R2 bucket protects against anonymous requests; it does not protect against another project's account-wide R2 token or a compromised Cloudflare administrator.

## Credential boundaries

| Credential                             | Intended authority                                                | Keep out of                                                                     |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Inbox token                            | Read and send for one active inbox                                | Cloudflare administration                                                       |
| Agentpost administrator token          | Manage Agentpost inboxes and application settings                 | Ordinary agent sessions and Cloudflare administration                           |
| Worker sending token                   | Email Sending Write for the sending account                       | DNS, D1, R2, Queues and Worker deployment permissions                           |
| Optional Worker diagnostics token      | Email Sending Read for the diagnostic account                     | Sending, DNS changes and storage administration                                 |
| Routine deployment token               | Individual Workers Editor for the existing Agentpost Worker       | Other Workers, direct D1/R2/Queues permissions and account token administration |
| Provisioning or maintenance credential | Only the additional operations needed for that maintenance window | Worker Secrets, agent clients and routine deployment environments               |

The Worker uses D1, R2 and Queue bindings without receiving a Cloudflare storage API token. Within a bound database or bucket, inbox isolation is enforced by Agentpost's authorization and scoped queries, not Cloudflare row-level or object-level IAM. A Worker Editor can change code that uses these bindings. Treat deployment authority as authority over that Worker's mail and application secrets; denial of direct storage API calls is not proof that the deployer cannot access the same data through Worker code.

## Scope routine deployment

After provisioning the Worker, create an **account-owned API token** in **Manage account → Account API tokens**:

1. Start a custom policy with **Specified Workers**.
2. Select only the existing Agentpost Worker and grant **Individual Workers → Editor**. Do not select Admin or a legacy account-wide Workers template.
3. Set an expiry appropriate for deployment frequency, for example 90 days. Record the renewal date privately. Deployment-token expiry does not stop an already deployed Worker's mail processing.
4. Save the secret in a secret manager or an ignored owner-only file. Inject it only into the deployment process as `CLOUDFLARE_API_TOKEN`, together with `CLOUDFLARE_ACCOUNT_ID`. These names belong to Wrangler; Agentpost application configuration still uses `AGENTPOST_`.

`bun run deploy` requires both explicit Wrangler variables and fails before deployment if either is missing. It cannot determine a token's actual policy from its string: an explicit but overprivileged token remains overprivileged. Do not put deployment credentials in `.dev.vars`, Worker Secrets, CLI/MCP configuration, GitHub pull-request jobs, or a project-wide environment inherited by every test and build.

Wrangler's `login` OAuth flow currently does not support granular authorization. Retain shared OAuth only for supervised provisioning/maintenance that needs it, or use a separate administrative profile. A dedicated deployment process must fail when its token is absent or expired rather than silently use that shared login.

### Deployment commands and maintenance

Per-Worker Editor can update existing Worker code, versions and deployments. It does not grant direct storage access. Cloudflare currently does not support Custom Domains with per-Worker roles; changing routes/domains or managing queue consumers, resources and database migrations can require separate permissions. Do not broaden the routine token just to make an all-in-one command succeed.

For a code-only rollout on an existing installation, use Wrangler's versions workflow with the reviewed configuration: `wrangler versions upload`, inspect the returned version, then `wrangler versions deploy VERSION_ID@100%`. Do not activate a version until all required migrations and binding/consumer changes have been completed and checked under the separate maintenance identity. Versions deployment does not apply every trigger or resource configuration change. A local dry run and reading version metadata do not prove a real upload/deployment will succeed with the token.

Follow [deployment](deploy.md) and [operations](operations.md) for upgrades and recovery. Do not deploy an old configuration over newly added bindings or activate new code against an unmigrated database.

## Audit other credentials in the same account

Inspect **both Account API tokens and My Profile → API Tokens**, including auto-generated Workers Builds credentials and R2-specific tokens. A token named after another project is not necessarily scoped to that project.

- **Workers:** replace account-wide legacy script-editing grants with Editor on the actual Workers used by that pipeline. Check its build trigger and repository before replacing or retiring the credential. Worker deployers remain trusted application administrators.
- **R2:** an account-wide Storage Read/Write token can access private buckets. For object uploads/downloads, prefer Object Read/Write on the named buckets and the S3-compatible API. Bucket-scoped object permissions do not work with the Cloudflare REST API or Wrangler object commands. Migrate REST-based consumers before narrowing their token; otherwise uploads can break.
- **D1:** a D1 Read grant includes SQL queries and can expose mail metadata. Avoid unrelated account-wide D1 grants and use a separate administrative identity for migrations. Do not claim per-database isolation unless the actual account policy supports and enforces it.
- **Queues:** review API grants as well as producer/consumer bindings. An HTTP publisher or pull consumer needs a management API token; private queue naming alone does not restrict such a token.
- **Global API key, user sessions and OAuth:** these are additional administrative paths. Restrict who holds them, protect the Cloudflare account with strong authentication, and inspect account members. Narrowing one project token does not revoke these other paths.

Replace consumers before revoking an active token. Record unresolved dependencies privately rather than deleting a token based only on its name or an empty last-used field. If other applications must remain untrusted even when their account-wide credentials or deployers are compromised, use a separate Cloudflare account; a new token alone does not establish that boundary.

## Verify without reading mail or sending messages

Using the new token, check that Agentpost's version/deployment metadata is accessible and another existing Worker's settings are denied. Check that direct D1 metadata, R2 bucket metadata, Queue metadata and account-token listing are denied. Use known existing resource IDs and compare with a separately authorized inventory; a nonexistent resource or arbitrary 404 is not evidence of isolation. Print only status and policy summaries, never bearer values or mail content. Do not test permissions by deleting data, publishing queue jobs, querying mail rows or modifying another Worker.

Separately confirm that the R2 bucket has **both** `r2.dev` disabled and no public custom domain, and that unauthenticated API/MCP requests are rejected. An inability to list a bucket root does not prove object URLs are private. These checks establish the observed access boundaries, not the absence of all application vulnerabilities.

Official references: [Workers roles and resource scopes](https://developers.cloudflare.com/workers/authorization/workers/), [granular Wrangler authentication](https://developers.cloudflare.com/workers/authorization/), [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/), [R2 public access](https://developers.cloudflare.com/r2/buckets/public-buckets/), [versions deployment](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/), [Queues HTTP consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/).
