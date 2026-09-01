---
name: cpp
description: Implementing C++ code.
---

# C++ 

## Stay Modern

Always aim to use the latest language and standard library features available
in a given workspace. Just because something is the "tried and true" way does
not mean it is necessarily the most elegant solution.

## GoogleTest/GoogleMock

- Make sure to set mock expectations before triggering expectations, to avoid
  undefined behaviour stated in gmock's docs.
