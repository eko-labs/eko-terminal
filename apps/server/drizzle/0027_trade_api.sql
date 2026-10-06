CREATE TABLE trade_quotes (
  id uuid PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL,
  wallet text,
  input jsonb NOT NULL,
  quote jsonb NOT NULL,
  checked jsonb,
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT trade_quotes_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX trade_quotes_owner_expiry ON trade_quotes(account_id, expires_at);
--> statement-breakpoint
CREATE TABLE trade_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_body text NOT NULL,
  order_hash text NOT NULL,
  coin text NOT NULL,
  side text NOT NULL,
  fee_bps integer NOT NULL,
  status text DEFAULT 'awaiting_signature' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT trade_orders_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT trade_orders_quote_id_trade_quotes_id_fk FOREIGN KEY (quote_id) REFERENCES trade_quotes(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX trade_orders_idem ON trade_orders(account_id, idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX trade_orders_quote ON trade_orders(quote_id);
