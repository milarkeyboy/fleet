-- Install + load plugins via Neovim's built-in plugin manager.
vim.pack.add({
  -- For things like the picker (LSP, FZF, etc.)
  "https://github.com/folke/snacks.nvim",

  -- file explorer
  "https://github.com/nvim-tree/nvim-tree.lua",

  -- LSP config helper
  "https://github.com/neovim/nvim-lspconfig",

  -- key-hints popup
  "https://github.com/folke/which-key.nvim",

  -- cmdline wildmenu/popup completion
  "https://github.com/gelguy/wilder.nvim",

  -- optional, but recommended highlight
  "https://github.com/nvim-treesitter/nvim-treesitter",

  -- Colour scheme
  "https://github.com/mofiqul/vscode.nvim",
  --
  -- Git blame and working-tree change indicators
  "https://github.com/lewis6991/gitsigns.nvim",
})

vim.cmd.colorscheme("vscode")

-- Plugin setups (safe to run after add(), because add() loads by default)
require("gitsigns").setup({
  -- Show trailing blame and make it snappy.
  current_line_blame = true,
  current_line_blame_opts = {
    delay = 0,
  },
})

require("nvim-tree").setup({
  git = {
    ignore = false,
  },
})

require("snacks").setup({
  picker = {
    enabled = true,
    -- Snacks has both a default and a Lua-specific symbol filter, so override
    -- both to include every symbol kind unless one is explicitly filtered.
    sources = {
      lsp_symbols = { filter = { default = true, lua = true } },
      lsp_workspace_symbols = { filter = { default = true, lua = true } },
    },
    win = require("keymaps").snacks_picker_win,
  },
})

-- Install parsers and enable Treesitter highlighting for each language.
local treesitter = require('nvim-treesitter')
local treesitter_filetypes = {}

for _, lang in ipairs(require('languages')) do
  treesitter.install(lang.ts)

  local parsers = type(lang.ts) == 'table' and lang.ts or { lang.ts }
  for _, parser in ipairs(parsers) do
    vim.list_extend(treesitter_filetypes, vim.treesitter.language.get_filetypes(parser))
  end
end

vim.api.nvim_create_autocmd('FileType', {
  pattern = treesitter_filetypes,
  callback = function()
    vim.treesitter.start()
  end,
})

-- which-key: keybinding hints popup
require("which-key").setup({
  preset = "modern",
  delay = 0,
})

local wilder = require('wilder')
wilder.setup({ modes = { ':', '/', '?' } })
wilder.set_option('renderer', wilder.popupmenu_renderer({
  -- highlighter applies highlighting to the candidates
  highlighter = wilder.basic_highlighter(),
}))

-- Register Wilder's Python functions once Neovim defines the command.
vim.api.nvim_create_autocmd('VimEnter', {
  once = true,
  callback = function()
    vim.cmd.UpdateRemotePlugins()
  end,
})
