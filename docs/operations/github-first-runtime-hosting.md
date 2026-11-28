# GitHub-first runtime hosting policy

The production VPS is a runtime target only. All source editing, worktrees, dependency resolution, compilation, test runs, research/training and release packaging take place off the production VPS. Use hosted GitHub Actions or an authorized isolated development environment, never the production host.

The VPS retains the active deployed application, at most one independently verified compatible rollback, required persistent configuration/data, certificates, protected backups, and runtime observability. It does not retain old worktrees, test environments or historical releases. Do not remove unique local work or necessary data to satisfy this rule; preserve and review it securely first.

## Transition

- The previous SSH-based deployment compiles directly on the VPS. Its job and seven legacy VPS research jobs are held in this change until their hosted replacements are verified. No trading runtime, process or database modification is performed by this change. Once merged, the existing automatic deployment is deliberately unavailable pending the artifact-only replacement.
- Hosted Runtime Build Candidate compiles the API, web and admin on a GitHub-hosted runner with exact commit identity and checksum manifests. Its outputs are explicitly intermediate, not a deployable release. Do not send these intermediates to the VPS.
- Next: build an ABI-compatible complete runtime package (including production dependencies, AI runtime and approved model provenance, migrations, install tools, and SBOM), verify artifact contents and authenticity, rehearse a clean-host installation and rollback, and publish a versioned GitHub Release only when all gates pass.
- Replace the legacy deploy job with an authenticated transfer of the exact approved artifact, verify checksums, enforce trading quiescence and shared deployment lock, switch runtime atomically, run health and acceptance checks, and retain one verified rollback. No git fetch/checkout, worktree creation, dependency installation or compilation on the target.
- Replace legacy training/research jobs with hosted compute and authorized data transfer; never upload private account records, broker credentials, secrets or unreviewed local history to public CI artifacts.
- Keep read-only production health and reconciliation diagnostics distinct from development jobs. Do not turn off runtime safeguards.

The active application must remain unchanged until the replacement passes all applicable release and recovery gates. This policy does not certify any candidate for live trading.
