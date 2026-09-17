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
})

vim.cmd.colorscheme("vscode")

-- Plugin setups (safe to run after add(), because add() loads by default)
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

-- Enable treesitter for each language
for _, lang in ipairs(require('languages')) do
  require('nvim-treesitter').install(lang.ts)
end

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
