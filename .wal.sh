#! /bin/bash

wal -R -n
feh --bg-scale "$(< "${HOME}/.cache/wal/wal")"
