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
Plug 'roxma/nvim-completion-manager'
Plug 'SirVer/ultisnips'
Plug 'honza/vim-snippets'
Plug 'brooth/far.vim'
Plug 'joshdick/onedark.vim'
Plug 'itchyny/lightline.vim'
Plug 'scrooloose/nerdcommenter'
Plug 'pangloss/vim-javascript'
Plug 'alvan/vim-closetag'
Plug 'hkalexling/jshint.vim'
Plug 'Chiel92/vim-autoformat'
Plug 'lervag/vimtex'
Plug 'kchmck/vim-coffee-script'
Plug 'digitaltoad/vim-pug'
Plug 'Valloric/YouCompleteMe'
Plug 'justinmk/vim-syntax-extra'
Plug 'wakatime/vim-wakatime'
Plug 'leafgarland/typescript-vim'
Plug 'chiel92/vim-autoformat'

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

filetype plugin on
filetype indent on

" Toggle NerdTree with F6
nmap <C-k><C-b> :NERDTreeToggle<CR>

set list
set listchars=eol:¶,tab:!·,trail:·

set tabstop=4
colorscheme onedark
syntax on
set shiftwidth=4
set smartindent
set noexpandtab " use tab instead of space to indent
set nu
set termguicolors
" Hide -- INSERT -- because lightline includes this
set noshowmode
" Toggle spell check with F6
map <F6> :setlocal spell! spelllang=en_us<CR>

" Map jj to escape
inoremap jj <esc>

let g:NERDTreeHijackNetrw=1

" paste without overwriting yarned text
xnoremap p "_dP

" disable default formating for foreign languages
let g:autoformat_autoindent = 0
let g:autoformat_retab = 0
let g:autoformat_remove_trailing_spaces = 0
" Map to F3 and auto format on writing
noremap <F3> :Autoformat<CR>
au BufWrite * :Autoformat
