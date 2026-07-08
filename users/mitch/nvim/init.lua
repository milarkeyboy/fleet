-- Basic editor settings
vim.o.number = true
vim.o.relativenumber = true
vim.o.termguicolors = true
vim.o.expandtab = true
vim.o.shiftwidth = 4
vim.o.tabstop = 4

vim.g.mapleader = " "

-- Plugins + their config
require("plugins")

-- Keymaps
vim.keymap.set("n", "<leader>e", "<cmd>NvimTreeToggle<CR>", { desc = "Explorer" })

vim.keymap.set("n", "<leader>f", "<cmd>Telescope find_files<CR>", { desc = "Find files" })
vim.keymap.set("n", "<leader>g", "<cmd>Telescope live_grep<CR>", { desc = "Grep" })
vim.keymap.set("n", "<leader>s", "<cmd>Telescope lsp_document_symbols<CR>", { desc = "Symbols (buffer)" })

-- LSP setup
require("lsp")

-- Enable terminal window title updates
vim.opt.title = true

-- Set the title string to the current working directory. This is to allow
-- identifying editor windows by their workspace.
vim.opt.titlestring = "nvim: " .. vim.fn.fnamemodify(vim.fn.getcwd(), ":t")
