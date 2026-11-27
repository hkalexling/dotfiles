# Local pi-claude-code changes

`d5b5e04c314d-local.patch` was taken from the installed [pi-claude-code](https://github.com/earendil-works/pi-claude-code) checkout at base commit `d5b5e04c314d3452d357174d16d10dda34daa2d2`.

To restore, start with a clean checkout at that base and run:

```sh
patch="$HOME/.config/yadm/patches/pi-claude-code/d5b5e04c314d-local.patch"
git apply --check "$patch"
git apply "$patch"
```
