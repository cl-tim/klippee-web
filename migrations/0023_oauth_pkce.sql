-- Migration number: 0023    2026-08-05T00:00:00.000Z

-- Bind every new OAuth authorization code to the browser flow that initiated
-- it. The column remains nullable during rollout so the previously deployed
-- Worker can continue creating states in the short migrations-before-deploy
-- window. The new Worker rejects null/invalid verifiers before contacting an
-- OAuth provider.
ALTER TABLE oauth_states
ADD COLUMN pkce_verifier TEXT
CHECK (
  pkce_verifier IS NULL
  OR (
    length(pkce_verifier) = 43
    AND pkce_verifier NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

-- Existing and migrations-before-deploy states remain NULL because they
-- cannot be upgraded after the fact. The new callback consumes and rejects
-- them before making any provider request, so affected users simply restart
-- sign-in after the deployment.
