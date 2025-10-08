#!/usr/bin/env -S deno test --allow-all

/**
 * Basic tests for the Mautic deployment system
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.200.0/assert/mod.ts";
import { Logger } from "./logger.ts";
import { ProcessManager } from "./process-manager.ts";
import { PackageManager } from "./package-manager.ts";
import { DockerManager } from "./docker-manager.ts";

Deno.test("Logger should initialize and log messages", async () => {
  // Test basic logging functionality
  Logger.log("Test message", "🧪");
  Logger.success("Test success");
  Logger.error("Test error");
  Logger.warning("Test warning");
  Logger.info("Test info");
  
  // Just verify no exceptions are thrown
  assertEquals(true, true);
});

Deno.test("ProcessManager should handle basic commands", async () => {
  // Test with a simple echo command
  const result = await ProcessManager.runShell("echo 'Hello World'");
  
  assertEquals(result.success, true);
  assertEquals(result.output, "Hello World");
  assertEquals(result.exitCode, 0);
});

Deno.test("ProcessManager should handle command failures", async () => {
  // Test with a command that should fail
  const result = await ProcessManager.runShell("false", { ignoreError: true });
  
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
});

Deno.test("ProcessManager should validate empty commands", async () => {
  try {
    await ProcessManager.run([]);
    assertEquals(false, true, "Should have thrown an error for empty command");
  } catch (error) {
    assertExists(error);
    assertEquals(error.message, "Command cannot be empty");
  }
});

Deno.test("DockerManager should check if Docker is available", async () => {
  // This might fail in CI but should not throw
  const isRunning = await DockerManager.isDockerRunning();
  
  // Just verify it returns a boolean
  assertEquals(typeof isRunning, "boolean");
});

Deno.test("PackageManager should check for apt locks", async () => {
  // This test is environment-dependent but should not throw
  const hasLocks = await PackageManager.checkAptLocks();
  
  // Just verify it returns a boolean
  assertEquals(typeof hasLocks, "boolean");
});

console.log("🧪 All tests completed!");