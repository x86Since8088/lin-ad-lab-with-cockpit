# Changelog

## 1.0.1 - 2026-09-07

Install classification is now decided by LAYOUT, not by a development-root path
prefix, and this plugin was deployed to its real install path on edt1.

- `install.sh` decides dev vs deployed by asking whether its own directory is
  what a sibling `payload` symlink resolves to. The old test compared `$SRC`
  against a hardcoded development root and got a checkout sitting ANYWHERE ELSE
  wrong: such a checkout classified itself `deployed`, so it skipped the
  group-writable warning, wrote INSTALL_KIND=deployed for a host that was not
  self-sustaining, and dropped "the checkout is not touched" from
  `--uninstall`. Reproduced before the change and confirmed fixed after.
- Because that literal is gone, pre-flight check 9 now scans `install.sh`
  itself. The carve-out that exempted it is removed. Both of the check's own
  patterns are split so the scanner cannot match itself; the string it searches
  for is unchanged, so nothing is weakened.
- `owned_by_us` recognises a dev link by `$SRC` rather than by "anywhere
  under the development root", which is tighter: it no longer adopts a link
  belonging to a different checkout of the same project.
- The uninstall notice and the dev warning ask the LINK TARGET's layout, so
  they stay correct when the deployed installer tears down links a dev install
  made.
- Added a VERSION file, and deploy.sh now REFUSES without one instead of
  silently defaulting to 1.0.0 - a fixed fallback names every payload directory
  the same thing and makes rollback impossible.
- Deployed to /opt/cockpit-adlab. The two files that reached into the
  development tree - /usr/share/cockpit/adlab/manifest.json and
  /usr/local/sbin/adlab-admin - no longer exist in that form.
- Fixed: tests/test_adlab_admin.py had its `unittest.main()` block ABOVE
  TestConfigLayer, so unittest exited before defining it and seven config-layer
  tests silently never ran (100 collected, not 107). The block is now last, with
  a comment saying why it must stay there.
- Added `TestSuiteCompleteness`, which compares the number of `def test_` in the
  file against what the loader actually collects and fails when they differ.
  A comment is not a control; this is. Proved by re-introducing the defect.
  The suite is 108 tests.
A recursive grep of the deployed tree for the development root or the retired
checkout path now returns nothing at all.
