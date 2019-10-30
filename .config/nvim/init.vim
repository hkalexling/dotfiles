call plug#begin('~/.local/share/nvim/plugged')

" https://vi.stackexchange.com/a/2577/16463
if !exists("g:os")
    if has("win64") || has("win32") || has("win16")
        let g:os = "Windows"
    else
        let g:os = substitute(system('uname'), '\n', '', '')
    endif
endif

Plug 'scrooloose/nerdtree', { 'on':  'NERDTreeToggle' }
Plug 'SirVer/ultisnips'
Plug 'honza/vim-snippets'
Plug 'brooth/far.vim'
Plug 'joshdick/onedark.vim'
Plug 'itchyny/lightline.vim'
Plug 'scrooloose/nerdcommenter'
Plug 'alvan/vim-closetag'
Plug 'hkalexling/jshint.vim'
Plug 'Chiel92/vim-autoformat'
Plug 'Valloric/YouCompleteMe'
Plug 'wakatime/vim-wakatime'
Plug 'chiel92/vim-autoformat'
Plug 'junegunn/goyo.vim'
Plug 'rbgrouleff/bclose.vim'
Plug 'francoiscabrol/ranger.vim'

" language syntaxs/supports
Plug 'justinmk/vim-syntax-extra'
Plug 'pangloss/vim-javascript'
Plug 'kchmck/vim-coffee-script'
Plug 'digitaltoad/vim-pug'
Plug 'leafgarland/typescript-vim'
Plug 'chr4/nginx.vim'
Plug 'lervag/vimtex'

if g:os == "Darwin"
	" Mac only plugins
	Plug 'euclio/vim-markdown-composer'
endif

call plug#end()

if g:os == "Darwin"
	" Mac only configs
	let vim_markdown_preview_github=1
	let vim_markdown_preview_browser='FirefoxDeveloperEdition'
endif

colorscheme onedark

let mapleader = " "

filetype plugin on
filetype indent on
set list
set listchars=eol:¶,tab:!·,trail:·
set clipboard=unnamedplus " use system clipboard
set tabstop=4
syntax on
set shiftwidth=4
set smartindent
set noexpandtab " use tab instead of space to indent
set nu
set termguicolors
set noshowmode
set colorcolumn=80 " 80 column line

" Map jj to escape
inoremap jj <esc>

" Toggle spell check with F6
map <F6> :setlocal spell! spelllang=en_us<CR>

" UltiSnips keys
let g:UltiSnipsExpandTrigger="kk"
let g:UltiSnipsJumpForwardTrigger="<C-j>"
let g:UltiSnipsJumpBackwardTrigger="<C-k>"

" Toggle NerdTree with C-k C-b
nmap <C-k><C-b> :NERDTreeToggle<CR>

" paste without overwriting yarned text
xnoremap p "_dP

" disable default formating for foreign languages
let g:autoformat_autoindent = 0
let g:autoformat_retab = 0
" Map to F3 and auto format on writing
noremap <F3> :Autoformat<CR>
au BufWrite * :Autoformat

" nginx file type
au BufRead,BufNewFile *.nginx set ft=nginx
au BufRead,BufNewFile */etc/nginx/* set ft=nginx
au BufRead,BufNewFile */usr/local/nginx/conf/* set ft=nginx
au BufRead,BufNewFile nginx.conf set ft=nginx

" YCM disable loading confirmation of .ycm_extra_conf.py
let g:ycm_confirm_extra_conf=0

let g:NERDTreeHijackNetrw = 0
let g:ranger_replace_netrw = 1
let g:ranger_command_override = 'ranger --cmd "set show_hidden=true"'
