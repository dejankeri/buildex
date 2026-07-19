"use strict";
// Entry point — boot() once every module is loaded.
// Part of the operator console (web/index.html). Classic script — loaded in order via
// <script src>, sharing one global scope. NOT an ES module.

// Kick off the console once every earlier <script src> has defined its globals.
boot();
