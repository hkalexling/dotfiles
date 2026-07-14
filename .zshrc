# OPENSPEC:START
# OpenSpec shell completions configuration
fpath=("/home/alex_ling/.oh-my-zsh/custom/completions" $fpath)
autoload -Uz compinit
compinit
# OPENSPEC:END

# Path to your oh-my-zsh installation.
export ZSH="/home/alex_ling/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="fino"


# Which plugins would you like to load?
# Standard plugins can be found in ~/.oh-my-zsh/plugins/*
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
	vi-mode
	colored-man-pages
)

source $ZSH/oh-my-zsh.sh

# Change hostname color when connected via SSH
if [[ -n "$SSH_TTY" ]]; then
  PROMPT="${PROMPT//38;5;033m/38;5;201m}"  # cyan → magenta
fi

# User configuration

export EDITOR="nvim"
export VISUAL="nvim"

ranger-cd() {
    ranger "$@"

    local sentinel="/tmp/ranger-marked-dir"
    if [ -f "$sentinel" ]; then
        local dir="$(cat "$sentinel")"
        rm -f "$sentinel"
        if [ -d "$dir" ] && [ "$dir" != "$PWD" ]; then
            cd "$dir"
        fi
    fi
}
alias ranger='ranger-cd'

# trash
alias rm='echo "Please use trash instead"; false'

# History in cache directory:
HISTSIZE=10000
SAVEHIST=10000
HISTFILE=~/.cache/zsh/history

# Basic auto/tab complete:
autoload -U compinit
zstyle ':completion:*' menu select
zmodload zsh/complist
compinit
_comp_options+=(globdots)		# Include hidden files.

# pywal
#(cat ~/.cache/wal/sequences &)

# nvm
source /usr/share/nvm/init-nvm.sh

# yay should only interact with AUR packages
alias yay="yay --aur"

export INPUT_METHOD=fcitx5
export GTK_IM_MODULE=fcitx5
export QT_IM_MODULE=fcitx5
export XMODIFIERS="@im=fcitx5"

# replace less with nvim
alias less='nvim -R -'

# MacOS like open command
alias open='xdg-open'

export ANDROID_HOME=/home/alex_ling/Android/Sdk

eval $(keychain --eval --quiet --noask id_rsa google_compute_engine github_rsa)

alias ls='lsd'

source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

alias copy='xclip -sel clip'

export BROWSER=/usr/bin/chromium

# system level yadm to manage files in /etc. See https://yadm.io/docs/faq#unconventional-cases
alias sysyadm="sudo yadm --yadm-dir /etc/yadm --yadm-data /etc/yadm/data"

# use direnv
eval "$(direnv hook zsh)"

# Go setup
export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin

# vcpkg
export VCPKG_ROOT=$HOME/Code/vcpkg

export LIBRARY_PATH="/usr/lib:/usr/local/lib:$LIBRARY_PATH"
export LD_LIBRARY_PATH="/usr/lib:/usr/local/lib:$LD_LIBRARY_PATH"
export CPATH="/usr/include:/usr/local/include:$CPATH"

[[ "$TERM_PROGRAM" == "kiro" ]] && . "$(kiro --locate-shell-integration-path zsh)"


# BEGIN opam configuration
# This is useful if you're using opam as it adds:
#   - the correct directories to the PATH
#   - auto-completion for the opam binary
# This section can be safely removed at any time if needed.
[[ ! -r '/home/alex_ling/.opam/opam-init/init.zsh' ]] || source '/home/alex_ling/.opam/opam-init/init.zsh' > /dev/null 2> /dev/null
# END opam configuration

export PATH=$PATH:~/.local/share/zvm/bin

# pnpm
export PNPM_HOME="/home/alex_ling/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end
. "$HOME/.cargo/env"
