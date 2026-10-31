# Publish Credential Operator Runbook

Status: **S2d implemented.** This is the operator procedure for the host-owned
HTTP(S) publish credential described in
[APPROVED_PUSH_PATH_CREDENTIALS.md](APPROVED_PUSH_PATH_CREDENTIALS.md). It covers
inspection, normal token rotation, emergency revocation and the audit trail.

The credential is a **short-lived lease**, not a general secret store. One lease
answers for one workspace, one remote, one resolved host set and one approved
commit. The secret lives only in the Linux Secret Service under
`publish-<leaseId>`; the SQLite ledger stores metadata, never the secret.

---

## 1. Preconditions

| Requirement | Why |
|---|---|
| A promoted release | `publish-credential grant` refuses a canonical checkout or an unset `UNIFIED_MPC_ROOT` with `publish-credential-unsupported`. The helper must live in an immutable, host-owned release directory. |
| Linux Secret Service | The secret is stored through `SecretToolSecretStore`. If it is unavailable, `grant` fails closed with `publish-credential-unavailable` and stores nothing. |
| One HTTPS push URL | A remote with zero or more than one push URL is refused (`publish-credential-unsupported` or `push-target-ambiguous`). SSH remotes keep the credential-free S1 path. |
| A registered workspace | `--workspace` accepts the workspace id, root path or real root path. |
| Provider-side token | Use a least-privilege token scoped to the repository and with an expiry. The host never mints or refreshes provider tokens. |

Grant from the running deployment:

```sh
export UNIFIED_MPC_ROOT="$HOME/.local/share/unified-mpc/runtime/current"
unified-mpc publish-credential grant origin \
  --workspace <workspace-id-or-path> \
  --username <provider-username> \
  --ttl 900
```

The command reads the secret from stdin only. Prefer the no-echo terminal
prompt: run the command in a terminal and paste the token when asked. For a
script, keep the value out of argv and shell history:

```sh
read -r -s NEW_TOKEN
printf '%s' "$NEW_TOKEN" | unified-mpc publish-credential grant origin \
  --workspace <workspace-id> --username <provider-username> --ttl 900
unset NEW_TOKEN
```

On success the command prints the lease id, workspace, remote, host set,
username and expiry. It never prints the secret.

---

## 2. Inspect before rotating

```sh
# One lease by id: metadata and state (active or revoked). A lease whose TTL
# passed is usually already reclaimed by the command's own sweep and reads
# not-found; a row the sweep could not delete still reports `expired`.
unified-mpc publish-credential status <leaseId>

# The remote's push target; grant refuses anything but exactly one HTTPS URL.
git -C /path/to/repo remote get-url --push --all origin
```

To find live leases without a lease id:

```sh
sqlite3 "${XDG_DATA_HOME:-$HOME/.local/share}/unified-mpc/unified-mpc.sqlite" <<'SQL'
SELECT lease_id,
       workspace_id,
       remote,
       hosts,
       username,
       datetime(created_at / 1000, 'unixepoch') AS created_utc,
       datetime(expires_at / 1000, 'unixepoch') AS expires_utc
FROM publish_credential_leases
WHERE revoked_at IS NULL AND expires_at > (unixepoch() * 1000)
ORDER BY created_at DESC;
SQL
```

The ledger is metadata only. Do not edit it directly and do not try to read the
secret from it.

---

## 3. Rotate a token

1. **Mint the replacement token** at the provider with the same repository scope
   and a short expiry. Do not delete the old token yet.
2. **Revoke the old lease**:

   ```sh
   unified-mpc publish-credential revoke <oldLeaseId>
   ```

   Revocation is idempotent and writes a `publish_credential_revoke` audit row.
   An id that was never granted is refused with no row: only a real revocation
   is reported as one. A lease that already outlived its TTL has no row left,
   because every credential command sweeps first, so `revoke` reports not-found
   and the token is already deleted.
3. **Grant the replacement lease** with the procedure in section 1. The new
   lease is a new id; never reuse the old id.
4. **Preflight the exact target** with `git_publish_preflight`. A live lease on
   a helper-blocked HTTP(S) target turns the block into a ready diagnostic.
5. **Approve and publish** the exact workspace, remote, branch and commit:
   `publish_approve` with `userConfirmed: true`, then `git_publish`. The publish
   spend writes one `publish_credential_use` row and revokes the lease on every
   exit path.
6. **Confirm the lease is gone**:

   ```sh
   unified-mpc publish-credential status <newLeaseId>
   ```

   The state must be `revoked`. A lease that outlived its TTL was usually
   reclaimed by the command's sweep already, so this prints `publish credential
   not found` and exits 0 — check the ledger query in section 4 before assuming
   the revocation failed.
7. **Delete the old provider token** after the old lease is revoked or expired.
   The provider-side delete is the only action that makes a leaked token
   unusable everywhere.

---

## 4. Emergency revocation

If a token may have leaked, revoke first and investigate second:

```sh
unified-mpc publish-credential revoke <leaseId>
```

Then delete the token at the provider. If the lease id is unknown, use the live
lease query in section 2. Revoking a lease removes the Secret Service entry and
makes the next `open` return no material. A publish already holding the opened
material keeps it only for that spawn; the receipt is single-use.

Do not rotate by overwriting a lease id, editing the ledger, or writing a
`publish-<id>` Secret Service entry by hand. Use `grant` and `revoke` so the
audit trail and the expiry sweep stay consistent.

---

## 5. Audit trail

`publish_credential_*` rows are written to `audit_events`. The metadata is a
closed list of non-secret fields: lease id, workspace, remote, hosts, username,
approval id, branch, expected SHA, push-URL fingerprint, result code, reason,
reclaimed count and duration. The secret never enters the audit input.

| Action | When it is written |
|---|---|
| `publish_credential_grant` | After `grant` stored the lease and secret. A failed grant writes no row. |
| `publish_credential_use` | Exactly once per credential-bound `git_publish` spend, after the lease is revoked, with the push result and reason. |
| `publish_credential_revoke` | After `revoke` completed. An already-revoked lease still succeeds, because revocation is idempotent. A lease id that was never granted is refused and writes no row. If the secret delete succeeds but the lease cannot be read back, the row carries result code `UNVERIFIED` and the command exits non-zero. |
| `publish_credential_sweep` | Only when the sweep reclaimed at least one lease. Empty sweeps stay quiet; the SQLite repository keeps a row whose secret delete failed for the next sweep, so a retry is not audited until it actually reclaims something. A failed ledger read or secret-store outage is also quiet, because `sweepExpired` fails closed to 0 — during an outage, check `status` and the logs rather than expecting a sweep row. |

Inspect the trail:

```sh
sqlite3 "${XDG_DATA_HOME:-$HOME/.local/share}/unified-mpc/unified-mpc.sqlite" <<'SQL'
SELECT timestamp,
       action,
       result_code,
       json_extract(metadata_json, '$.leaseId') AS lease_id,
       json_extract(metadata_json, '$.reason') AS reason
FROM audit_events
WHERE action LIKE 'publish_credential%'
ORDER BY timestamp DESC
LIMIT 50;
SQL
```

Audit writes are **best effort**. A failed insert never changes a publish,
grant, revoke or sweep result; the credential state change has already
happened. If a row is missing, check that the SQLite database is writable and
that the disk is not full; the next lifecycle action can still succeed.

A `publish_credential_use` row covers the credential-bound publish spend. The
diagnostic `git_publish_preflight` and the approve preflight reuse the same
lease for `ls-remote`; they are not separate `use` rows, so the trail stays one
row per publish.

---

## 6. Troubleshooting

| Symptom | Meaning and action |
|---|---|
| `publish-credential-unsupported` | The deployment is a canonical checkout, `UNIFIED_MPC_ROOT` is unset, the push URL is not HTTPS, or the remote has no push URL. Grant from a promoted release with exactly one HTTPS push URL. |
| `push-target-ambiguous` | The remote resolves to more than one push URL. Name one target or switch the remote to one URL; credential targets cannot half-succeed. |
| `publish-credential-unavailable` | No live lease, the lease expired or was revoked, the receipt names a different lease, or Secret Service is unavailable. Inspect with `status`, then grant a new lease. |
| `publish-credential-required` | The preflight sees a helper-configured HTTP(S) target and no live lease. Grant a lease first. |
| `publish-target-changed` | `remote.origin.url` changed after the grant or approval. Re-resolve the URL, grant for the new host if it is intended, and approve the new binding. |
| `push-credential-helper` | The guard still refuses the operation, or the helper is not the host-owned executable of the running release. Check the deployment and the remote transport. |
| `publish-credential-not-found` | The lease id is not in the ledger. It was mistyped, or its TTL passed and the pre-command sweep already reclaimed it. Nothing was revoked; check the ledger query in section 4. |
| `publish-credential-unverified` | The Secret Service entry was deleted, but the ledger could not confirm the lease. The token is gone from this host; check the `UNVERIFIED` audit row and delete the provider token if the host cannot be trusted. |
| Lease stays `active` after a publish | The push may have failed before the spend, or the revoke failed and the TTL sweep will reclaim it. Inspect the publish result and the audit row, then `revoke` explicitly if needed. |

---

## 7. What not to do

- Do not put the token in the remote URL, `GIT_*` environment variables, argv,
  a file, or a repository `credential.helper`.
- Do not use `git push` for a credential target. Only `git_publish` spends a
  receipt and a lease.
- Do not grant from a canonical checkout, a nested release path, or an
  unverified `UNIFIED_MPC_ROOT`.
- Do not raise the TTL beyond the publish window. The lease should outlive one
  push plus its verification, nothing more.
- Do not reuse a lease id or re-grant a consumed receipt.
