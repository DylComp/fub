-- Pump curve permissions are explicit. Existing signatures keep their original routes.
ALTER TABLE fomo_token22_permissions DROP CONSTRAINT IF EXISTS fomo_token22_permissions_check;
ALTER TABLE fomo_token22_permissions ADD CONSTRAINT fomo_token22_permissions_check CHECK((
 ((scope->>'policy'='raydium-token22-sol-v1' AND scope->>'version' IN ('1','2','3','4')) OR
  (scope->>'policy'='raydium-native-sol-v2' AND scope->>'version' IN ('5','6')) OR
  (scope->>'policy'='native-sol-venues-v3' AND scope->>'version' IN ('7','8')) OR
  (scope->>'policy'='native-sol-venues-v4' AND scope->>'version' IN ('9','10')))
 AND scope->>'wallet'=wallet AND scope->>'planId'=plan_id::text AND scope->>'id'=id::text
 AND ((scope->>'version' IN ('1','3','5','7','9') AND NOT scope ? 'mint') OR
      (scope->>'version' IN ('2','4','6','8','10') AND jsonb_typeof(scope->'mint')='string'))
) IS TRUE);
ALTER TABLE fomo_token22_executions DROP CONSTRAINT IF EXISTS fomo_token22_executions_check;
ALTER TABLE fomo_token22_executions ADD CONSTRAINT fomo_token22_executions_check CHECK((
 ((review->>'version'='1' AND NOT (review->'accounts') ? 'tokenProgram' AND NOT (review->'accounts') ? 'pumpFees') OR
  (review->>'version'='2' AND review->'accounts'->>'tokenProgram'='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' AND NOT (review->'accounts') ? 'pumpFees') OR
  (review->>'version'='3' AND review->'accounts'->>'tokenProgram'='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
   AND jsonb_typeof(review->'accounts'->'pumpFees')='array' AND jsonb_array_length(review->'accounts'->'pumpFees')=3) OR
  (review->>'version'='4' AND review->'curve'->>'version'='1'
   AND review->'curve'->'request'->>'wallet'=wallet
   AND review->'curve'->>'messageHash'=message_hash
   AND review->'curve'->>'unsigned'=review->>'unsigned'
   AND review->'curve'->'request'->>'mint'=review->'accounts'->>'mint'
   AND review->'curve'->'request'->>'direction'=review->'accounts'->>'direction'
   AND review->'curve'->'request'->>'inputRaw'=review->'accounts'->>'inputRaw'))
 AND (review->>'version'='4' OR NOT review ? 'curve')
 AND review->'accounts'->>'wallet'=wallet AND review->>'messageHash'=message_hash
) IS TRUE);
