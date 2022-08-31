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
Plug 'joshdick/onedark.vim'
Plug 'itchyny/lightline.vim'
Plug 'scrooloose/nerdcommenter'
Plug 'alvan/vim-closetag'
Plug 'Valloric/YouCompleteMe', { 'do': './install.py --clang-completer' }
Plug 'wakatime/vim-wakatime'
Plug 'chiel92/vim-autoformat', { 'do': 'npm install -g js-beautify' }
Plug 'dense-analysis/ale'
Plug 'junegunn/goyo.vim'
Plug 'skywind3000/vim-quickui'
"Plug 'dylanaraps/wal.vim'

" Ranger
Plug 'rbgrouleff/bclose.vim'
Plug 'francoiscabrol/ranger.vim'

" Vertical line at column 80
Plug 'Yggdroot/indentLine'

" Unix commands like :Chmod and :Delete
Plug 'tpope/vim-eunuch'

" Documentation generator
Plug 'kkoomen/vim-doge'

" DBUI
Plug 'tpope/vim-dadbod'
Plug 'kristijanhusak/vim-dadbod-ui'

" Ack frontend
Plug 'dyng/ctrlsf.vim'

" Highlights unique characters in a line for easier f/t
Plug 'unblevable/quick-scope'

Plug 'github/copilot.vim', {'branch': 'release'}

" language syntaxs/supports
Plug 'justinmk/vim-syntax-extra'
Plug 'pangloss/vim-javascript'
Plug 'digitaltoad/vim-pug'
Plug 'chr4/nginx.vim'
Plug 'rhysd/vim-crystal'
Plug 'posva/vim-vue'
Plug 'leafgarland/typescript-vim'
Plug 'peitalin/vim-jsx-typescript'
Plug 'styled-components/vim-styled-components', { 'branch': 'main' }
Plug 'jvirtanen/vim-hcl'
Plug 'hashivim/vim-terraform'

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
set relativenumber

" Map jj to escape
inoremap jj <esc>

" Toggle spell check with F6
map <F6> :setlocal spell! spelllang=en_us<CR>

" Toggle NerdTree with C-k C-b
nmap <C-k><C-b> :NERDTreeToggle<CR>

" paste without overwriting yarned text
xnoremap p "_dP

" disable default formating for foreign languages
let g:autoformat_autoindent = 0
let g:autoformat_retab = 0
" Map to F3 and auto format on writing
noremap <F3> :Autoformat<CR>

fun! FormatWrapper()
	let ignoreRegex = "javascript|typescript|react|typescriptreact"
	let indentRegex = "ecrystal"
	if match(&ft, ignoreRegex)
		return
	elseif match(&ft, indentRegex)
		:normal gg=G
	else
		:Autoformat
	endif
endfun

au BufWrite * call FormatWrapper()

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

let g:indentLine_char_list = ['|', '¦', '┆', '┊']

" Exit terminal with ESC
tnoremap <Esc> <C-\><C-n>

" Fix the werid `q` character when using nvim over ssh
set guicursor=

" Keep trailing spaces in diff
autocmd FileType diff let g:autoformat_remove_trailing_spaces=0

" Spell check in gitcommit
autocmd FileType gitcommit setlocal spell spelllang=en_us

" Respect Crystal formatting
autocmd FileType crystal setlocal shiftwidth=2 softtabstop=2 expandtab
autocmd FileType ecrystal.* setlocal shiftwidth=2 softtabstop=2 expandtab
" Auto format Crystal
let g:formatdef_crystal = '"crystal tool format -"'
let g:formatters_crystal = ['crystal']

" Close tabs to the right
command Cr :.+1,$tabdo :tabc

let g:ale_fixers = {
 \ 'javascript': ['prettier', 'eslint'],
 \ 'typescript': ['prettier', 'eslint'],
 \ }
let g:ale_fix_on_save = 1

" CtrlSF bindings
nmap <C-j><C-k> <Plug>CtrlSFPrompt
nnoremap <C-j><C-j> :CtrlSFToggle<CR>

" QuickUI menu
let g:quickui_border_style = 2
let g:quickui_color_scheme = 'papercol dark'
call quickui#menu#reset()

call quickui#menu#install("&File", [
			\ ["&Unlink\t:Unlink", 'Unlink'],
			\ ["&Rename\t:Rename", 'exec input("", ":Rename ")'],
			\ ["&Chmod\t:Chmod", 'exec input("", ":Chmod ")'],
			\ ["&Mkdir\t:Mkdir", 'exec input("", ":Mkdir ")'],
			\ ["&Sudo Write\t:SudoWrite", 'SudoWrite'],
			\ ['--', ''],
			\ ["Close &Tabs to the Right\t:Cr", ':.+1,$tabdo :tabc']
			\])

call quickui#menu#install("&Tools", [
			\ ["Spell &Check %{&spell? 'Off' : 'On'}\tF6", 'setlocal spell! spelllang=en_us'],
			\ ["&NERDTree\t<C-k><C-b>", 'NERDTreeToggle'],
			\ ['--', ''],
			\ ["&Search CtrlSF\t<C-j><C-k>", 'exec input("", ":CtrlSF ")'],
			\ ["&Open CtrlSF\t<C-j><C-j>", 'CtrlSFToggle'],
			\ ])

call quickui#menu#install("&Shells", [
			\ ["&Python", 'call quickui#terminal#open("python3", {"title":"Python 3"})'],
			\ ["&Node", 'call quickui#terminal#open("node", {"title":"Node"})']
			\])

noremap <Space><Space> :call quickui#menu#open()<CR>

au FileType typescript setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType typescriptreact setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType javascript setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType react setlocal shiftwidth=2 softtabstop=2 expandtab
