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

# User configuration

export EDITOR="nvim"
export VISUAL="nvim"

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

eval $(keychain --eval --quiet --noask id_rsa google_compute_engine github_rsa)

source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
