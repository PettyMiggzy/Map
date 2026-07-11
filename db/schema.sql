-- Bubble-map indexer schema (Postgres / Neon — SEPARATE database from the catboy bot!).
-- Chain-wide scale: consider ClickHouse for `transfers` if volume gets large.

CREATE TABLE IF NOT EXISTS bm_cursor (      -- checkpoint per token (or 'chain' for whole-chain)
  scope    text PRIMARY KEY,                -- token address or 'chain'
  last_block bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bm_transfers (
  token    text  NOT NULL,
  block    bigint NOT NULL,
  log_index int  NOT NULL,
  tx       text  NOT NULL,
  "from"   text  NOT NULL,
  "to"     text  NOT NULL,
  value    numeric NOT NULL,
  PRIMARY KEY (token, block, log_index)
);
CREATE INDEX IF NOT EXISTS bm_tx_token_from ON bm_transfers (token, "from");
CREATE INDEX IF NOT EXISTS bm_tx_token_to   ON bm_transfers (token, "to");

-- Token registry: metadata + last-computed summary. Powers the API's token label,
-- the token search box, and whole-chain enumeration (each row is a token we index).
CREATE TABLE IF NOT EXISTS bm_tokens (
  token       text PRIMARY KEY,             -- lowercased contract address
  name        text,
  symbol      text,
  decimals    int,
  holders     int,
  supply      numeric,
  transfers   int,
  active      boolean NOT NULL DEFAULT true, -- cron indexes tokens where active = true
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Native-ETH funding edges (phase 2, sourced from Alchemy getAssetTransfers category=external).
-- Powers "funded by the same wallet" clustering — the strongest insider signal.
CREATE TABLE IF NOT EXISTS bm_funding (
  wallet   text NOT NULL,
  funder   text NOT NULL,
  block    bigint NOT NULL,
  PRIMARY KEY (wallet, funder, block)
);
CREATE INDEX IF NOT EXISTS bm_funding_funder ON bm_funding (funder);
