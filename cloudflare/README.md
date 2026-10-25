# Cloudflare (Access, Worker, web UI)

Cloudflare is the front door. Access checks who you are on your hostname, and a
Worker forwards admitted `/api/*` requests to the Lambda function URL from
[`../aws`](../aws/README.md). The same Worker serves the chat UI.

| Folder | Holds |
|---|---|
| [`worker/`](worker/) | The edge Worker (`src/index.ts`) and `wrangler.example.jsonc`. |
| [`web/`](web/) | The chat UI (Vite and TypeScript, no framework). `npm run build` writes to `worker/public`, which the Worker serves. |

## Deploy

### 1. Access application

Do this first, before the AWS stacks, so you have its values:

- Zero Trust -> Access -> Applications -> Add -> Self-hosted, with your
  hostname, an **Allow** policy for you (for example your email, with One-time
  PIN) and a **separate** policy for a service token whose action is
  **Service Auth**. A service token under an Allow policy is not accepted.
- Note the **Application Audience (AUD) tag** and your **team domain**
  (`<team>.cloudflareaccess.com`). They go in `aws/deploy.local.json`.

### 2. Worker and web UI

After the AWS stacks are deployed, so you have the `FunctionUrl` output. Lambda
rejects requests whose Host header isn't the function URL's own host. Rewriting
Host with an Origin Rule needs the Enterprise plan, so a small Worker forwards
requests instead (`fetch` sets Host from the target URL).

```sh
(cd cloudflare/web && npm install && npm run build)   # the web UI, into worker/public
cd cloudflare/worker
cp wrangler.example.jsonc wrangler.jsonc   # set your hostname and the function URL
npx wrangler login   # once
npx wrangler deploy
```

In the git-ignored `wrangler.jsonc`, set `routes[0].pattern` to your hostname and
`vars.ORIGIN` to the `FunctionUrl` output without the trailing slash. If `ORIGIN`
is left as the `<function-url-host>` placeholder, every `/api/*` call fails with
`500 proxy misconfigured`; in the web UI that shows as `request failed (HTTP 500)`
and an empty Harness list.

The Worker serves the web UI from `worker/public` and forwards only `/api/*` to
the Lambda. Rebuild the UI before each deploy that should include UI changes. If
`/` returns `{"error":"not found"}` instead of the page, the deployed Worker is
older than the UI and still forwards every path to the Lambda: build the UI and
run `npx wrangler deploy` again.

The Worker is attached to your hostname as a custom domain, which creates the
DNS record itself. Delete any existing CNAME for that name first. Cloudflare
Access must protect that hostname, so the Worker only sees requests that already
carry a valid token.

## Web UI

Open `https://<your-hostname>/` in a browser and sign in through Cloudflare
Access. The browser holds no keys: Access adds the signed JWT to each request
itself.

- Pick a harness and the maximum output tokens, then chat. Replies stream in and
  are rendered as Markdown. **Stop** cancels a reply.
- Each chat is one harness session. Chats are kept in your browser's local
  storage only, so they don't follow you to another browser or device.
- After about 15 minutes idle, the harness session ends and the agent forgets the
  earlier messages. The page says so when you return to such a chat.

`npm run dev` in `web/` serves the page locally, but without the `/api` routes.
