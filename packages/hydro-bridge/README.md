# Hydro Bridge

This optional Hydro 5 add-on provides a persistent local outbox, signed webhook delivery and six read-only `/club-bridge/v1` routes. The entry point is `dist/index.js` and exports `apply(ctx)`. It reads Hydro models and writes only `club_bridge.outbox`, `club_bridge.resources` and `club_bridge.nonces`; it does not register users, enroll participants, edit contests or award club points.

## Build and local verification

```sh
pnpm --filter @acm/hydro-bridge build
pnpm --filter @acm/hydro-bridge test
```

The package keeps `hydrooj` as a runtime peer. The TypeScript path mapping uses the minimal API declarations in `src/hydrooj-stubs.d.ts`, because the npm Hydro package exposes source compiled by Hydro's own toolchain. This local build verifies the bridge against those declarations; it does not establish compatibility with a school's actual installation. Protocol tests compare canonical bytes and signatures with `packages/integrations/src/hydro-protocol.ts`. Collection and handler tests use test doubles, not a live MongoDB or Hydro server.

## Test-instance configuration

Load the compiled absolute package directory using the school's supported add-on mechanism. For the documented Hydro 5 mechanism, administrators can use `hydrooj addon add /absolute/path/to/packages/hydro-bridge` on a test instance. Do not run this against production before its version and installed plug-ins have been reviewed.

Supply environment variables or set `HYDROOJ_CLUB_CONFIG` to a private JSON configuration file. The default file is `~/.hydro/club-bridge.json`; environment variables take precedence.

```json
{
  "instanceId": "11111111-1111-4111-8111-111111111111",
  "endpoint": "https://club.example.edu.cn",
  "pushKeyId": "hydro:11111111-1111-4111-8111-111111111111",
  "pushSecret": "replace-with-a-random-secret-of-at-least-32-bytes",
  "pullKeyId": "hydro-pull:11111111-1111-4111-8111-111111111111",
  "pullSecret": "replace-with-a-different-random-secret-of-at-least-32-bytes",
  "serviceAccountUid": 1001,
  "allowedDomains": ["acm-club"],
  "allowedContests": [],
  "delivery": { "intervalMs": 5000, "batchSize": 20, "concurrency": 4, "timeoutMs": 10000 },
  "refresh": { "intervalMs": 15000, "batchSize": 50 },
  "sweepLookbackDays": 180,
  "sweepIntervalMs": 21600000
}
```

| JSON field | Environment variable |
| --- | --- |
| `instanceId` | `HYDROOJ_CLUB_INSTANCE_ID` |
| `endpoint` | `HYDROOJ_CLUB_ENDPOINT` |
| `pushKeyId`, `pushSecret` | `HYDROOJ_CLUB_PUSH_KEY_ID`, `HYDROOJ_CLUB_PUSH_SECRET` |
| `pullKeyId`, `pullSecret` | `HYDROOJ_CLUB_PULL_KEY_ID`, `HYDROOJ_CLUB_PULL_SECRET` |
| `serviceAccountUid` | `HYDROOJ_CLUB_SERVICE_ACCOUNT_UID` |
| `allowedDomains`, `allowedContests` | `HYDROOJ_CLUB_ALLOWED_DOMAINS`, `HYDROOJ_CLUB_ALLOWED_CONTESTS` |

Environment lists are comma separated. The endpoint must be a fixed HTTP(S) origin without credentials, query, fragment or path; webhook requests always use `/api/v1/integrations/hydro/events`. Delivery rejects redirects. Use trusted HTTPS in the school environment and configure the club connector with matching instance, domain and directional keys. Secrets never appear in capabilities responses.

Create a dedicated service account with `PERM_VIEW`, `PERM_VIEW_CONTEST`, `PERM_VIEW_CONTEST_SCOREBOARD` and `PERM_VIEW_RECORD` in each allowed domain. Every signed pull checks that account's current permissions and group assignment. Private contests require their exact IDs in `allowedContests` as well as native account access. The legacy `allowPrivateContests` field cannot grant access to all private contests. Hidden scoreboard and source-code permissions do not enable hidden exports in this first version.

## Routes and consistency

The read routes are `capabilities`, `contests`, `contests/:tid`, `contests/:tid/participants`, `contests/:tid/records` and `contests/:tid/results` under `/club-bridge/v1`. Domain-prefixed installations use `/d/{domainId}/club-bridge/v1/...`; signatures must cover the actual external path. GET bodies are empty and query keys are limited to sorted, RFC3986-encoded `cursor` and `limit` on paginated routes. Each request requires the five `X-Hydro-*` headers, a fresh random nonce and a timestamp within 300 seconds. Nonces remain stored beyond the acceptance window.

Hooks mark one local resource document. A CAS writes the bridge revision and an immutable pending event together before copying it into the outbox, so an interrupted copy can resume with the original event ID and bytes. New hooks during refresh leave the resource dirty. Mongo delivery leases include a fresh token; expired deliveries can be reclaimed and old tokens cannot acknowledge them. Retries preserve the event body and generate fresh signature headers. Network errors, 408/425/429 and 5xx retry with jittered backoff; other HTTP failures become dead letters. Inspect those documents and correct configuration before an administrator intentionally requeues them.

Startup and periodic sweeps inspect at most 500 recent contests per allowed domain and at most 5000 participant states per contest. Participant revisions, enrollment, team membership and result aggregates are part of the contest source hash, allowing periodic repair to notice missed hooks. These bounds need to be checked against the school's contest volume. Results beyond the bound stop for an explicit pagination adapter. Response size is capped at 1 MiB; ordinary pages contain at most 200 entries.

## Remaining school verification

No real Hydro instance is bundled or contacted by local tests. The actual school version must verify add-on loading/unloading, Mongo driver behavior, multiple-process leases, native access policy, route prefixes, and permissions. Compare individual/team ACM, OI/IOI, ties, unrank, freeze/unlock, flexible duration, AC-to-WA rejudging and deletions with the native scoreboard. The read results route marks ended preliminary rankings `pending_review` because judge completeness and native ranking equivalence have not been established. It does not present those rows as approved scoring facts.

The core state update and bridge hook are not one atomic transaction. Periodic repair is still required, and no exactly-once guarantee is claimed. A live installation must also measure hook latency, backlog recovery and Mongo write failures. Binding assertions, automatic enrollment, contest creation and a rating-history provider are outside this first delivery. The full contract and school acceptance conditions are in `docs/scheme/07-hydro-oj-plugin.md`.
