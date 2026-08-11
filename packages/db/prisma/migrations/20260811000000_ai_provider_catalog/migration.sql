-- Replace the AiProviderKind vendor enum with a registry catalog key.
--
-- An enum meant a database migration every time a new provider appeared, which
-- is the wrong shape for a list that grows constantly. A string keyed to the
-- catalog in @fluid/ai makes adding OpenRouter, CometAPI or anything else a
-- one-line registry entry.
--
-- Existing rows are mapped rather than reset, so nobody loses their configured
-- provider. LOCAL becomes "ollama": that enum value already meant "an
-- OpenAI-compatible endpoint on my own machine", which is what Ollama is.

ALTER TABLE "ai_settings" ADD COLUMN "providerId" TEXT NOT NULL DEFAULT 'anthropic';

UPDATE "ai_settings" SET "providerId" = CASE "provider"
  WHEN 'ANTHROPIC' THEN 'anthropic'
  WHEN 'OPENAI'    THEN 'openai'
  WHEN 'GOOGLE'    THEN 'google'
  WHEN 'LOCAL'     THEN 'ollama'
  ELSE 'anthropic'
END;

ALTER TABLE "ai_settings" DROP COLUMN "provider";

DROP TYPE "AiProviderKind";
