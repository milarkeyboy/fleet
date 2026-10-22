-- Basic editor settings
vim.o.number = true
vim.o.relativenumber = true
vim.o.termguicolors = true
vim.o.expandtab = true
vim.o.shiftwidth = 4
vim.o.tabstop = 4

-- Keep Meson buffers using the editor's indentation defaults.
vim.g.meson_recommended_style = false

local prose_filetypes = { "markdown", "gitcommit" }

-- Wrap prose and other filetypes' comments while typing.
vim.api.nvim_create_autocmd("FileType", {
  pattern = "*",
  callback = function(event)
    vim.opt_local.textwidth = 80
    if vim.tbl_contains(prose_filetypes, event.match) then
      vim.opt_local.formatoptions:append("t")
    else
      vim.opt_local.formatoptions:append("c")

      -- Leave code formatting to LSPs and the like.
      vim.opt_local.formatoptions:remove("t")
    end
  end,
})

-- Resize windows when neovim itself is resized:
-- https://neovim.io/doc/user/autocmd/#VimResized
vim.cmd(":autocmd VimResized * wincmd =")

vim.g.mapleader = " "

-- Plugins + their config
require("plugins")

-- Keymaps
require("keymaps").setup()

-- LSP setup
require("lsp")

-- Enable terminal window title updates
vim.opt.title = true

-- Set the title string to the current working directory. This is to allow
-- identifying editor windows by their workspace.
vim.opt.titlestring = "nvim: " .. vim.fn.fnamemodify(vim.fn.getcwd(), ":t")

-- Spell checking. Maybe I'll look at migrating over to CSpell later.
vim.opt.spell = true
vim.opt.spelllang = { "en_gb" }
vim.opt.spelloptions:append("camel")
