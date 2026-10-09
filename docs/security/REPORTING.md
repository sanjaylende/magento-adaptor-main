# Reporting a security problem

Send reports to the address in `SECURITY_CONTACT` (served at `/.well-known/security.txt`; the default is
`mailto:security@flipick.com`, **change it to a mailbox you read** in the server's environment). Please include what you found,
how to reproduce it, and the address of the system. We aim to answer within 3 working days. Please do not test against other
merchants' data or run denial-of-service tests.

# Repository protection checklist (apply in GitHub, needs repository admin)

Settings, Branches, add a rule for `main`:
- [ ] Require a pull request before merging, with at least 1 approval
- [ ] Require status checks to pass: `CI` and every job of `Security`
- [ ] Require branches to be up to date; require conversation resolution
- [ ] Block force pushes and deletion; include administrators
- [ ] Require signed commits (optional but recommended)

Settings, Code security:
- [ ] Dependency graph, Dependabot alerts and Dependabot security updates **on**
- [ ] Secret scanning and **push protection** on
- [ ] Code scanning (CodeQL) default setup or the workflow in `.github/workflows/security.yml`
- [ ] Private vulnerability reporting on

Settings, Actions:
- [ ] Workflow permissions: read-only by default
- [ ] Allow only actions from GitHub and the pinned ones used here; require full-length commit SHAs for actions

Settings, Deploy keys and access:
- [ ] Deploy keys read-only, one per server, rotated yearly
- [ ] Two-factor required for everyone with access (organisation setting)
- [ ] Review who has write and admin access every quarter
