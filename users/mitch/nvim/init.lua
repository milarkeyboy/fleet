-- Basic editor settings
vim.o.number = true
vim.o.relativenumber = true
vim.o.termguicolors = true
vim.o.expandtab = true
vim.o.shiftwidth = 4
vim.o.tabstop = 4
vim.opt.completeopt = { "menuone", "noselect", "popup" }

-- Keep Markdown prose at a review-friendly line length while typing.
vim.api.nvim_create_autocmd("FileType", {
  pattern = "markdown",
  callback = function()
    vim.opt_local.textwidth = 80
    vim.opt_local.formatoptions:append("t")
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
