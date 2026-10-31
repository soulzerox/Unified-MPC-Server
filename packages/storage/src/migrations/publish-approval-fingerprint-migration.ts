/**
 * Credential binding for a publish receipt (issue #297, S2c).
 *
 * A credential-bound receipt records the resolved push-host fingerprint the
 * human approved and the lease that may answer for that host, so the publish
 * path can refuse a receipt whose remote was redirected after approval
 * (`publish-target-changed`). Both columns are nullable: every receipt minted
 * before this migration, and every receipt minted for a credential-free target,
 * is a valid credential-free capability and keeps S1 behaviour unchanged.
 */
export const PUBLISH_APPROVAL_FINGERPRINT_MIGRATION_SQL = `
ALTER TABLE publish_approvals ADD COLUMN push_url_fingerprint TEXT;
ALTER TABLE publish_approvals ADD COLUMN lease_id TEXT;
`;
