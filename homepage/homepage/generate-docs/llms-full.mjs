import { promises as fs } from "fs";
import path from "path";
import { DOC_SECTIONS, FRAMEWORKS } from "./utils/config.mjs";
import { writeDocsFile } from "./utils/index.mjs";
import { mdxToMd } from "./utils/mdx-processor.mjs";

const CWD = process.cwd();
const CLASSIC_WARNING = await fs.readFile(path.join(CWD, "scripts/classic-docs-warning.md"), "utf8");
const EXCLUDE_PATTERNS = [/\/upgrade\//];

// Map each framework to its representative example
const FRAMEWORK_EXAMPLES = {
  react: "music-player",
  "react-native": "chat-rn",
  "react-native-expo": "chat-rn-expo",
  svelte: "chat-svelte",
  vanilla: "chat",
};

// ============================================================================
// File Walking & Discovery
// ============================================================================

async function walkDocsDirectory(dir, basePath = "") {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);

    if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(fullPath))) continue;

    if (entry.isDirectory()) {
      results.push(...(await walkDocsDirectory(fullPath, relativePath)));
    } else if (entry.name.endsWith(".mdx")) {
      results.push({ fullPath, relativePath });
    }
  }

  return results;
}

async function loadDirectoryContent(dirPath) {
  const results = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await loadDirectoryContent(fullPath)));
    } else {
      const content = await fs.readFile(fullPath, "utf-8");
      results.push({ filepath: fullPath, content });
    }
  }

  return results;
}

// ============================================================================
// Markdown File Generation
// ============================================================================

async function writeMarkdownFile(outputPath, content) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content);
  console.log(`Generated: ${path.relative(CWD, outputPath)}`);
}

async function generateFrameworkSpecificFile(fullPath, relativePath) {
  const framework = path.basename(relativePath, ".mdx");
  const dirPath = path.dirname(relativePath);
  const content = await mdxToMd(fullPath, framework);
  const outputPath = path.join(CWD, "public/docs", framework, dirPath + ".md");
  await writeMarkdownFile(outputPath, content);
}

async function generateGenericFile(fullPath, relativePath) {
  // Generate generic version (no framework filtering)
  const genericContent = await mdxToMd(fullPath);
  const genericPath = path.join(
    CWD,
    "public/docs",
    relativePath.replace(/\.mdx$/, ".md")
  );
  await writeMarkdownFile(genericPath, genericContent);

  // Generate framework-specific versions with filtering
  // This redundancy avoids adding hundreds of dynamic routes which slows compilation
  for (const framework of FRAMEWORKS) {
    const frameworkContent = await mdxToMd(fullPath, framework);
    const frameworkPath = path.join(
      CWD,
      "public/docs",
      framework,
      relativePath.replace(/\.mdx$/, ".md")
    );
    await writeMarkdownFile(frameworkPath, frameworkContent);
  }
}

async function generateFrameworkIndexFiles() {
  const indexPath = path.join(CWD, "content/docs/index.mdx");
  
  for (const framework of FRAMEWORKS) {
    try {
      const content = await mdxToMd(indexPath, framework);
      const outputPath = path.join(CWD, "public/docs", `${framework}.md`);
      await writeMarkdownFile(outputPath, content);
    } catch (error) {
      console.warn(`Error generating ${framework} index:`, error.message);
    }
  }
}

async function generateMarkdownFiles() {
  const docsDir = path.join(CWD, "content/docs");
  const mdxFiles = await walkDocsDirectory(docsDir);

  console.log(`Processing ${mdxFiles.length} source files...`);

  for (const { fullPath, relativePath } of mdxFiles) {
    try {
      const filename = path.basename(relativePath, ".mdx");
      const isFrameworkSpecific = FRAMEWORKS.includes(filename);

      if (isFrameworkSpecific) {
        await generateFrameworkSpecificFile(fullPath, relativePath);
      } else {
        await generateGenericFile(fullPath, relativePath);
      }
    } catch (error) {
      console.warn(`Error processing ${relativePath}:`, error.message);
    }
  }

  await generateFrameworkIndexFiles();
}

// ============================================================================
// LLM Documentation Generation
// ============================================================================

async function readMdxContent(url, framework = null) {
  try {
    const relativePath = url === "/docs" ? "index.mdx" : url.replace(/^\/docs\/?/, "");
    const fullPath = path.join(CWD, "content/docs", relativePath);

    if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(fullPath))) {
      return null;
    }

    // Check if it's a directory
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        const files = await fs.readdir(fullPath);
        let mdxFiles = files.filter(
          (f) => f.endsWith(".mdx") && !EXCLUDE_PATTERNS.some((p) => p.test(f))
        );
        
        // Filter framework-specific files
        mdxFiles = mdxFiles.filter((file) => {
          const fileBasename = path.basename(file, ".mdx");
          const isFrameworkFile = FRAMEWORKS.includes(fileBasename);
          
          if (framework) {
            // Include if: matches current framework OR not a framework-specific file
            return fileBasename === framework || !isFrameworkFile;
          } else {
            // Generic case: exclude all framework-specific files
            return !isFrameworkFile;
          }
        });
        
        if (mdxFiles.length === 0) return null;

        const contents = await Promise.all(
          mdxFiles.map((file) => mdxToMd(path.join(fullPath, file), framework))
        );
        return contents.join("\n\n---\n\n");
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    // Try reading as a single .mdx file
    const mdxPath = fullPath.endsWith(".mdx") ? fullPath : fullPath + ".mdx";
    return await mdxToMd(mdxPath, framework);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Failed to read ${url}:`, error.message);
    }
    return null;
  }
}

async function appendExampleCode(output, exampleName) {
  try {
    const examplePath = path.resolve(CWD, `../../examples/${exampleName}/src`);
    const files = await loadDirectoryContent(examplePath);

    output.push(`## ${exampleName} Example\n`);
    for (const { filepath, content } of files) {
      const relativePath = path.relative(examplePath, filepath);
      const extension = path.extname(relativePath).substring(1);
      output.push(`### ${relativePath}\n`);
      output.push(`\`\`\`${extension}\n${content}\n\`\`\`\n`);
    }
  } catch (error) {
    console.warn(`Could not read ${exampleName} example:`, error.message);
  }
}

function initializeOutputs() {
  return {
    generic: ["# Classic Jazz\n", CLASSIC_WARNING, "\n"],
    ...Object.fromEntries(
      FRAMEWORKS.map((fw) => [fw, [`# Classic Jazz (${fw})\n`, CLASSIC_WARNING, "\n"]])
    ),
  };
}

function addToAllOutputs(outputs, ...lines) {
  for (const output of Object.values(outputs)) {
    output.push(...lines);
  }
}

async function buildDocumentationContent(outputs) {
  for (const section of DOC_SECTIONS) {
    addToAllOutputs(outputs, `## ${section.title}\n`);

    for (const page of section.pages) {
      if (!page.url) continue;

      addToAllOutputs(outputs, `### ${page.title}`);

      // Read content for all variants in parallel
      const [genericContent, ...frameworkContents] = await Promise.all([
        readMdxContent(page.url),
        ...FRAMEWORKS.map((fw) => readMdxContent(page.url, fw)),
      ]);

      // Append content to respective outputs
      if (genericContent) outputs.generic.push(genericContent);
      outputs.generic.push("\n");
      
      FRAMEWORKS.forEach((framework, i) => {
        if (frameworkContents[i]) outputs[framework].push(frameworkContents[i]);
        outputs[framework].push("\n");
      });
    }
  }

  // Add resources section
  addToAllOutputs(
    outputs,
    "## Resources\n",
    "- [Jazz v2.0 and later documentation](https://jazz.tools/docs): Current documentation for new projects",
    "- [Examples](https://jazz.tools/examples): Code examples and tutorials\n"
  );
}

async function writeOutputFiles(outputs) {
  // Ensure framework directories exist upfront
  await Promise.all(
    FRAMEWORKS.map((fw) =>
      fs.mkdir(path.join(CWD, "public", fw), { recursive: true })
    )
  );

  // Write generic files
  await writeDocsFile("llms.txt", outputs.generic.join("\n"));

  const genericWithExample = [...outputs.generic];
  await appendExampleCode(genericWithExample, "music-player");
  await writeDocsFile("llms-full.txt", genericWithExample.join("\n"));

  // Write framework-specific files in parallel
  await Promise.all(
    FRAMEWORKS.map(async (framework) => {
      const frameworkOutput = [...outputs[framework]];
      await writeDocsFile(`${framework}/llms.txt`, frameworkOutput.join("\n"));
      const frameworkOutputWithExample = [...frameworkOutput];
      await appendExampleCode(frameworkOutputWithExample, FRAMEWORK_EXAMPLES[framework]);
      await writeDocsFile(`${framework}/llms-full.txt`, frameworkOutputWithExample.join("\n"));
    })
  );
}

async function generateDocs() {
  console.log("Generating markdown files...");
  await generateMarkdownFiles();

  console.log("Building LLM documentation content...");
  const outputs = initializeOutputs();
  await buildDocumentationContent(outputs);
  
  console.log("Writing output files...");
  await writeOutputFiles(outputs);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Generating LLM documentation...");
  await generateDocs();
  console.log("Documentation generated successfully.");
}

main().catch(console.error);
