-- Basic editor settings
vim.o.number = true
vim.o.relativenumber = true
vim.o.termguicolors = true
vim.o.expandtab = true
vim.o.shiftwidth = 4
vim.o.tabstop = 4

-- Keep Markdown prose at a review-friendly line length while typing.
vim.api.nvim_create_autocmd("FileType", {
  pattern = "markdown",
  callback = function()
    vim.opt_local.textwidth = 80
    -- Allow wrapping as I'm typing.
    vim.opt_local.formatoptions:append("t")
  end,
})

-- Wrap C++ comments while typing, leaving code line lengths unchanged.
vim.api.nvim_create_autocmd("FileType", {
  pattern = "cpp",
  callback = function()
    -- Comments width
    vim.opt_local.textwidth = 80
    vim.opt_local.formatoptions:append("c")

    -- Disable normal text (code) wrapping, leaving that to LSPs and the like.
    vim.opt_local.formatoptions:remove("t")
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
