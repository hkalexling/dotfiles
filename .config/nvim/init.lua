-- ============================================================
-- PLUGINS (vim.pack)
-- ============================================================

vim.pack.add({
  -- File explorer
  'https://github.com/scrooloose/nerdtree',
  'https://github.com/rbgrouleff/bclose.vim',
  'https://github.com/francoiscabrol/ranger.vim',

  -- UI
  'https://github.com/joshdick/onedark.vim',
  'https://github.com/itchyny/lightline.vim',
  'https://github.com/junegunn/goyo.vim',
  'https://github.com/skywind3000/vim-quickui',
  'https://github.com/unblevable/quick-scope',

  -- LSP and treesitter
  'https://github.com/neovim/nvim-lspconfig',
  'https://github.com/mason-org/mason.nvim',
  'https://github.com/mason-org/mason-lspconfig.nvim',
  'https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim',
  'https://github.com/nvim-treesitter/nvim-treesitter',

  -- Copilot
  'https://github.com/zbirenbaum/copilot.lua',

  -- Session management
  'https://github.com/dhruvasagar/vim-prosession',
  'https://github.com/tpope/vim-obsession',

  -- Utilities
  'https://github.com/tpope/vim-eunuch',
  'https://github.com/wakatime/vim-wakatime',
})

-- ============================================================
-- OPTIONS
-- ============================================================

vim.cmd.colorscheme('onedark')

vim.g.mapleader = ' '

vim.opt.list = true
vim.opt.listchars = { eol = '¶', tab = '!·', trail = '·' }
vim.opt.tabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true
vim.opt.smartindent = true
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.termguicolors = true
vim.opt.showmode = false
vim.opt.colorcolumn = '80'
vim.opt.scrollback = 32768
vim.opt.guicursor = '' -- Fix weird q character over SSH

-- ============================================================
-- KEYMAPS
-- ============================================================

-- Map jj to escape
vim.keymap.set('i', 'jj', '<Esc>')

-- Toggle spell check with F6
vim.keymap.set('n', '<F6>', ':setlocal spell! spelllang=en_us<CR>')

-- Toggle NerdTree with C-k C-b
vim.keymap.set('n', '<C-k><C-b>', ':NERDTreeToggle<CR>')

-- Paste without overwriting yanked text
vim.keymap.set('x', 'p', '"_dP')

-- Exit terminal with ESC
vim.keymap.set('t', '<Esc>', '<C-\\><C-n>')

-- System clipboard
vim.keymap.set('n', '<Leader>y', '"+y')
vim.keymap.set('n', '<Leader>p', '"+p')
vim.keymap.set('v', '<Leader>y', '"+y')
vim.keymap.set('v', '<Leader>p', '"+p')

-- Comment mappings (NERDCommenter style)
vim.keymap.set('n', '<Leader>cc', 'gcc', { remap = true, desc = 'Comment line' })
vim.keymap.set('v', '<Leader>cc', 'gc', { remap = true, desc = 'Comment selection' })
vim.keymap.set('n', '<Leader>cu', 'gcc', { remap = true, desc = 'Uncomment line' })
vim.keymap.set('v', '<Leader>cu', 'gc', { remap = true, desc = 'Uncomment selection' })

-- QuickUI menu
vim.keymap.set('n', '<Space><Space>', ':call quickui#menu#open()<CR>')

-- ============================================================
-- AUTOCOMMANDS
-- ============================================================

local augroup = vim.api.nvim_create_augroup('UserConfig', { clear = true })

-- Filetype settings

vim.api.nvim_create_autocmd('FileType', {
  group = augroup,
  pattern = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'c', 'crystal', 'ecrystal.*' },
  callback = function()
    vim.opt_local.shiftwidth = 2
    vim.opt_local.softtabstop = 2
    vim.opt_local.expandtab = true
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  group = augroup,
  pattern = 'c3',
  callback = function()
    vim.opt_local.shiftwidth = 4
    vim.opt_local.tabstop = 4
    vim.opt_local.expandtab = false
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  group = augroup,
  pattern = 'gitcommit',
  callback = function()
    vim.opt_local.spell = true
    vim.opt_local.spelllang = 'en_us'
  end,
})

-- nginx filetype detection
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  group = augroup,
  pattern = { '*.nginx', '*/etc/nginx/*', '*/usr/local/nginx/conf/*', 'nginx.conf' },
  callback = function()
    vim.bo.filetype = 'nginx'
  end,
})

-- ============================================================
-- LSP (Native)
-- ============================================================

require("mason").setup()
require("mason-lspconfig").setup()
require('mason-tool-installer').setup {
  ensure_installed = {
    'clangd',
    'copilot-language-server',
    'deno',
    'eslint-lsp',
    'lua-language-server',
    'rust-analyzer',
    'typescript-language-server',
    'zls',
  }
}

vim.lsp.config('lua_ls', {
  on_init = function(client)
    client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua, {
      workspace = {
        checkThirdParty = false,
        library = {
          vim.env.VIMRUNTIME
        }
      }
    })
  end
})

-- Native LSP completion
vim.api.nvim_create_autocmd('LspAttach', {
  group = augroup,
  callback = function(args)
    local bufnr = args.buf
    vim.lsp.completion.enable(true, args.data.client_id, args.buf, { autotrigger = true })
    vim.lsp.inline_completion.enable(true, { bufnr = bufnr })

    -- Popup completion menu navigation
    vim.keymap.set('i', '<C-K>', function()
      if vim.fn.pumvisible() == 1 then
        return '<C-p>'
      end
      return '<C-K>'
    end, { expr = true, buffer = bufnr, desc = 'Completion: previous item' })

    vim.keymap.set('i', '<C-J>', function()
      if vim.fn.pumvisible() == 1 then
        return '<C-n>'
      end
      return '<C-J>'
    end, { expr = true, buffer = bufnr, desc = 'Completion: next item' })

    vim.keymap.set('i', '<Tab>', function()
      if vim.fn.pumvisible() == 1 then
        return '<C-y>'
      end
      -- Fall back to inline completion accept or regular tab
      if not vim.lsp.inline_completion.get() then
        return '<Tab>'
      end
    end, { expr = true, buffer = bufnr, desc = 'Completion: confirm / accept inline' })
  end,
})

-- Format on save
vim.api.nvim_create_autocmd('BufWritePre', {
  group = augroup,
  callback = function()
    vim.lsp.buf.format({ async = false })
  end,
})

-- Don't select completion item automatically
vim.cmd("set completeopt+=noselect")

-- ============================================================
-- PLUGIN CONFIG
-- ============================================================

-- NERDTree / Ranger
vim.g.NERDTreeHijackNetrw = 0
vim.g.ranger_replace_netrw = 1
vim.g.ranger_command_override = 'ranger --cmd "set show_hidden=true"'

-- C syntax
vim.g.c_syntax_for_h = 1

-- QuickUI menu setup
vim.g.quickui_border_style = 2
vim.g.quickui_color_scheme = 'papercol dark'

-- Close tabs to the right
vim.api.nvim_create_user_command('Cr', ':.+1,$tabdo :tabc', {})
vim.fn['quickui#menu#reset']()
vim.fn['quickui#menu#install']('&File', {
  { '&Unlink\t:Unlink',              'Unlink' },
  { '&Rename\t:Rename',              'exec input("", ":Rename ")' },
  { '&Chmod\t:Chmod',                'exec input("", ":Chmod ")' },
  { '&Mkdir\t:Mkdir',                'exec input("", ":Mkdir ")' },
  { '&Sudo Write\t:SudoWrite',       'SudoWrite' },
  { '--',                            '' },
  { 'Close &all tabs',               'enew | tabonly' },
  { 'Close &Tabs to the Right\t:Cr', ':.+1,$tabdo :tabc' },
})
vim.fn['quickui#menu#install']('&Tools', {
  { "Spell &Check %{&spell? 'Off' : 'On'}\tF6", 'setlocal spell! spelllang=en_us' },
  { '&NERDTree\t<C-k><C-b>',                    'NERDTreeToggle' },
})
