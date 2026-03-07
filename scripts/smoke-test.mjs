import("./../src/index.ts")
  .then((mod) => {
    if (typeof mod.default !== "function") {
      throw new Error("Default export is not a function");
    }
    console.log("✓ Extension loads and exports a function");
  })
  .catch((error) => {
    console.error("✗ Extension failed to load:", error);
    process.exitCode = 1;
  });
