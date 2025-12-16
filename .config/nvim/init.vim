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
"Plug 'Valloric/YouCompleteMe', { 'do': './install.py --clang-completer' }
Plug 'wakatime/vim-wakatime'
Plug 'dense-analysis/ale'
Plug 'junegunn/goyo.vim'
Plug 'skywind3000/vim-quickui'
Plug 'tpope/vim-obsession'
Plug 'dhruvasagar/vim-prosession'
Plug 'nvim-lua/plenary.nvim'
Plug 'nvim-telescope/telescope.nvim', { 'tag': '0.1.8' }

" Autocompletion and LSP
Plug 'hrsh7th/nvim-cmp'
Plug 'hrsh7th/cmp-nvim-lsp'
Plug 'onsails/lspkind.nvim'
Plug 'neovim/nvim-lspconfig'

" Ranger
Plug 'rbgrouleff/bclose.vim'
Plug 'francoiscabrol/ranger.vim'

" Vertical line at column 80
Plug 'Yggdroot/indentLine'

" Unix commands like :Chmod and :Delete
Plug 'tpope/vim-eunuch'

" Highlights unique characters in a line for easier f/t
Plug 'unblevable/quick-scope'

" GitHub Copilot
Plug 'zbirenbaum/copilot.lua'
Plug 'zbirenbaum/copilot-cmp'

" Code companion
Plug 'nvim-lua/plenary.nvim'
Plug 'nvim-treesitter/nvim-treesitter'
Plug 'olimorris/codecompanion.nvim'
Plug 'MeanderingProgrammer/render-markdown.nvim'
Plug 'echasnovski/mini.diff'

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
Plug 'nikvdp/ejs-syntax'
Plug 'habamax/vim-godot'
Plug 'mrcjkb/rustaceanvim'
Plug 'qnighy/lalrpop.vim'
Plug 'ziglang/zig.vim'

call plug#end()

colorscheme onedark

let mapleader = " "

filetype plugin on
filetype indent on
set list
set listchars=eol:¶,tab:!·,trail:·
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
set scrollback=32768

" Map jj to escape
inoremap jj <esc>

" Toggle spell check with F6
map <F6> :setlocal spell! spelllang=en_us<CR>

" Toggle NerdTree with C-k C-b
nmap <C-k><C-b> :NERDTreeToggle<CR>

" paste without overwriting yarned text
xnoremap p "_dP

function! DebugMsg(msg) abort
    if !exists("g:DebugMessages")
        let g:DebugMessages = []
    endif
    call add(g:DebugMessages, a:msg)
endfunction

function! PrintDebugMsgs() abort
  if empty(get(g:, "DebugMessages", []))
    echo "No debug messages."
    return
  endif
  for ln in g:DebugMessages
    echo "- " . ln
  endfor
endfunction

command DebugStatus call PrintDebugMsgs()

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

" Close tabs to the right
command Cr :.+1,$tabdo :tabc

let g:c_syntax_for_h = 1

let g:ale_fixers = {
 \ 'javascript': ['prettier', 'eslint'],
 \ 'typescript': ['prettier', 'eslint'],
 \ 'react': ['prettier', 'eslint'],
 \ 'typescriptreact': ['prettier', 'eslint'],
 \ 'javascriptreact': ['prettier', 'eslint'],
 \ 'c': ['clang-format'],
 \ 'json': ['prettier', 'jq'],
 \ 'go': ['gofmt'],
 \ 'rust': ['rustfmt'],
 \ }
let g:ale_fix_on_save = 1

" Telescope
nnoremap ff <cmd>Telescope find_files<cr>
nnoremap fg <cmd>Telescope live_grep<cr>

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
			\ ["Close &all tabs", 'enew | tabonly'],
			\ ["Close &Tabs to the Right\t:Cr", ':.+1,$tabdo :tabc']
			\])

call quickui#menu#install("&Tools", [
			\ ["Spell &Check %{&spell? 'Off' : 'On'}\tF6", 'setlocal spell! spelllang=en_us'],
			\ ["&NERDTree\t<C-k><C-b>", 'NERDTreeToggle'],
			\ ])

noremap <Space><Space> :call quickui#menu#open()<CR>

noremap <Leader>y "+y
noremap <Leader>p "+p

au FileType gitcommit setlocal spell spelllang=en_us

au FileType crystal setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType ecrystal.* setlocal shiftwidth=2 softtabstop=2 expandtab

" Load LSP fix for Neovim 0.11.3 bug
lua require('lsp-fix')
au FileType typescript setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType typescriptreact setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType javascript setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType react setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType c setlocal shiftwidth=2 softtabstop=2 expandtab
au FileType c3 setlocal shiftwidth=4 tabstop=4 noexpandtab

let g:NERDCustomDelimiters = { 'c3': { 'left': '/*', 'right': '*/', 'leftAlt': '//' } }

lua << EOF
local cmp = require('cmp')
local lspkind = require('lspkind')
local has_words_before = function()
	if vim.api.nvim_buf_get_option(0, "buftype") == "prompt" then return false end
	local line, col = unpack(vim.api.nvim_win_get_cursor(0))
	return col ~= 0 and vim.api.nvim_buf_get_text(0, line-1, 0, line-1, col, {})[1]:match("^%s*$") == nil
end
cmp.setup {
	sources = {
		{ name = "copilot" },
		{ name = 'nvim_lsp' },
	},
	mapping = {
		['<C-k>'] = cmp.mapping.select_prev_item(),
		['<C-j>'] = cmp.mapping.select_next_item(),
		['<C-Space>'] = cmp.mapping.complete(),
		['<C-e>'] = cmp.mapping.abort(),
		["<Tab>"] = cmp.mapping.confirm({ select = false }),
	},
	formatting = {
		format = lspkind.cmp_format({
			mode = 'symbol',
			maxwidth = {
				menu = 50, -- leading text (labelDetails)
				abbr = 40, -- actual suggestion item
			},
			ellipsis_char = '...',
			symbol_map = { Copilot = "" },
			show_labelDetails = true,
		}),
	},
}
EOF

lua << EOF
require("copilot").setup({
	suggestion = { enabled = false },
	panel = { enabled = false },
	filetype = {
		["*"] = true,
	},
})
require("copilot_cmp").setup()
EOF

lua << EOF
require('mini.diff').setup()
EOF

lua << EOF
require("codecompanion").setup({
	display = {
		diff = {
			enabled = true,
			provider = "mini_diff", -- default|mini_diff
		},
	},
})
EOF

lua << EOF
require('render-markdown').setup({
	file_types = { 'markdown', 'codecompanion' },
})
EOF

lua << EOF
vim.lsp.enable('zls')
vim.lsp.enable('clangd')
EOF
