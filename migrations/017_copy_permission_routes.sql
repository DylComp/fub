-- Preserve v1 consent as shared routes only. New challenges explicitly bind v2
-- route and token-account policies. No permission row is upgraded or activated.
CREATE OR REPLACE VIEW fomo_copy_authorized_plans AS
SELECT p.*, g.id AS permission_id, g.expires_at AS permission_expires_at
FROM fomo_copy_plans p JOIN fomo_copy_permissions g ON g.plan_id=p.id AND g.wallet=p.wallet AND g.plan_version=p.version
WHERE NOT p.archived AND g.accepted_at IS NOT NULL AND g.revoked_at IS NULL
  AND g.issued_at<=statement_timestamp() AND g.expires_at>statement_timestamp()
  AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet)
  AND ((g.scope->>'version'='1' AND NOT(g.scope ? 'routePolicy') AND NOT(g.scope ? 'accountPolicy')) OR
       (g.scope->>'version'='2' AND g.scope->>'routePolicy'='jupiter-reviewed-v2' AND g.scope->>'accountPolicy'='standard-token-ata')) AND g.scope->>'origin'='https://fomo-pay.vercel.app' AND g.scope->>'network'='solana:mainnet'
  AND g.scope->>'leader'=p.leader AND g.scope->>'leader'=p.data->>'address'
  AND g.scope->'buyCents'=p.data->'buyCents' AND g.scope->'dailyCents'=p.data->'dailyCents'
  AND g.scope->'slippageBps'=p.data->'slippageBps' AND g.scope->'copySells'=p.data->'copySells'
  AND g.scope->>'maxNetworkFeeLamports'='1000000' AND g.scope->>'maxRentLamports'='2500000';
