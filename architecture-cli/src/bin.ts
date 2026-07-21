#!/usr/bin/env node
import { defaultCliIO, runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), defaultCliIO);
