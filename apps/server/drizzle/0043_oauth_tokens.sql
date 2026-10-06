CREATE TABLE "oauth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL,
  "code_id" uuid,
  "access_prefix" text NOT NULL,
  "access_hash" text NOT NULL,
  "refresh_prefix" text NOT NULL,
  "refresh_hash" text NOT NULL,
  "access_expires_at" timestamp with time zone NOT NULL,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "refresh_consumed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_tokens_code_id_unique" UNIQUE("code_id"),
  CONSTRAINT "oauth_tokens_access_prefix_unique" UNIQUE("access_prefix"),
  CONSTRAINT "oauth_tokens_refresh_prefix_unique" UNIQUE("refresh_prefix"),
  CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "oauth_grants"("id") ON DELETE cascade,
  CONSTRAINT "oauth_tokens_code_id_oauth_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "oauth_codes"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE FUNCTION oauth_revoke_key_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    IF TG_TABLE_NAME = 'agent_keys' THEN
      IF NEW.oauth_grant_id IS NOT NULL THEN
        UPDATE oauth_grants SET revoked_at=NEW.revoked_at WHERE id=NEW.oauth_grant_id AND revoked_at IS NULL;
      END IF;
    ELSIF TG_TABLE_NAME = 'oauth_grants' THEN
      UPDATE agent_keys SET revoked_at=NEW.revoked_at WHERE oauth_grant_id=NEW.id AND revoked_at IS NULL;
      UPDATE oauth_tokens SET revoked_at=NEW.revoked_at WHERE grant_id=NEW.id AND revoked_at IS NULL;
      INSERT INTO audit_log(account_id,action,data) VALUES(NEW.account_id,'oauth.revoke',jsonb_build_object('grantId',NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER oauth_key_revoke AFTER UPDATE OF revoked_at ON agent_keys FOR EACH ROW EXECUTE FUNCTION oauth_revoke_key_grant();
--> statement-breakpoint
CREATE TRIGGER oauth_grant_revoke AFTER UPDATE OF revoked_at ON oauth_grants FOR EACH ROW EXECUTE FUNCTION oauth_revoke_key_grant();
