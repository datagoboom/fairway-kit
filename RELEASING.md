# Releasing

Both packages release together from one tag. No tokens are stored anywhere —
publishing uses OIDC trusted publishing.

## One-time setup

**PyPI** (works before the project exists — "pending publisher"):

1. pypi.org → Account settings → Publishing → Add a pending publisher:
   - PyPI project name: `fairway-kit`
   - Owner: `datagoboom`, Repository: `fairway-kit`
   - Workflow name: `release.yml`
   - Environment: `pypi`
2. In the GitHub repo: Settings → Environments → create `pypi` (no secrets needed).

**npm** (trusted publishing config requires the package to exist, so the very
first publish is manual):

1. First release only, from `js/`: `npm login`, then
   `npm run build && npm publish` (locks the `fairway-kit` name).
2. npmjs.com → package `fairway-kit` → Settings → Trusted publisher:
   - Organization/user: `datagoboom`, Repository: `fairway-kit`
   - Workflow filename: `release.yml`
   - Environment: `npm`
3. In the GitHub repo: Settings → Environments → create `npm`.

After step 2, delete/revoke any npm token used for step 1.

## Every release

1. Bump `version` in **both** `python/pyproject.toml` and `js/package.json`
   (they must match — the workflow enforces it).
2. Update the protocol version note in README/PROTOCOL.md if it changed.
3. Commit, then tag and push:

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

The `release` workflow re-runs both test suites, verifies tag == both package
versions, builds, and publishes to PyPI and npm.
