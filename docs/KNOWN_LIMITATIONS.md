# Known limitations

- Offline editing is not supported. The UI pauses graph mutations while disconnected instead of claiming an unsent-operation queue.
- Concurrent edits to different fields of one node merge independently; concurrent edits to the same scalar field use Yjs conflict resolution and may not preserve both users' intent.
- PostgreSQL plus Redis multi-instance behavior is implemented and failure-policy tested, but the published latency run is single-process, loopback, and in-memory. There is no multi-host production capacity claim.
- Redis-only mode retains its ordered stream and deliberately does not compact without the PostgreSQL-backed distributed snapshot lock.
- Semantic version history requires PostgreSQL. Development memory mode returns an explicit unavailable response for durable checkpoint creation.
- JWTs have expiry but no server-side denylist. Guest JWTs are server-verified identities, not proof of a real human identity.
- Audit records are application records, not an immutable external compliance log.
- Architecture rules are explainable lint policies and graph analyses, not universal architectural truth or formal verification.
- SARIF/JSON describe deterministic findings, but rule suppression policy is not yet managed through an organization-wide policy service.
- Terraform and Docker Compose export support only the node subset listed by the IR service. Unsupported resources fail explicitly. Import and general round-trip conversion are not implemented.
- Terraform output is a deterministic supported model, not a guarantee that every generated deployment is secure, cost-effective, or appropriate for a specific provider account.
- The optional LLM explains deterministic findings and can generate a separate draft architecture, but generated text/graphs remain untrusted suggestions.
- The current live benchmark does not measure server CPU, server memory growth, Redis throughput, PostgreSQL latency, TLS, WAN latency, or browser rendering.
- Deployment to Cloudflare Workers/Sites is not configured. The backend depends on a long-running Socket.IO process and would require an explicit hosting/runtime migration.
