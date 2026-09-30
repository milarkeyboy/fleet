---
name: cpp
description: Implementing C++ code. Load this if you are going to write C++ code. Do not load this if you are merely reviewing C++ code, or planning changes to C++ code.
---

# C++ 

## Stay Modern

Always aim to use the latest language and standard library features available
in a given workspace. Just because something is the "tried and true" way does
not mean it is necessarily the most elegant solution.

## GoogleTest/GoogleMock

- Make sure to set mock expectations before triggering expectations, to avoid
  undefined behaviour stated in gmock's docs.
