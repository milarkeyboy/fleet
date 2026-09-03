-- Install + load plugins via Neovim's built-in plugin manager.
vim.pack.add({
  -- deps
  "https://github.com/nvim-lua/plenary.nvim",

  -- fuzzy finder
  "https://github.com/nvim-telescope/telescope.nvim",

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
})

-- Plugin setups (safe to run after add(), because add() loads by default)
require("nvim-tree").setup()

require("telescope").setup({
  defaults = {
    layout_strategy = "flex",
    sorting_strategy = "ascending",
    mappings = require("keymaps").telescope,
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

wilder = require('wilder')
wilder.setup({ modes = { ':', '/', '?' } })
wilder.set_option('renderer', wilder.popupmenu_renderer({
  -- highlighter applies highlighting to the candidates
  highlighter = wilder.basic_highlighter(),
}))
