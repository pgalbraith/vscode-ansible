/* node "stdlib" */
import * as fs from "fs";
import os from "node:os";
import path from "node:path";

/* vscode"stdlib" */
import * as vscode from "vscode";

/* third-party */
import * as ini from "ini";

const homeDirectory = os.homedir();

export default function untildify(pathWithTilde: string) {
  if (typeof pathWithTilde !== "string") {
    throw new TypeError(`Expected a string, got ${typeof pathWithTilde}`);
  }

  return homeDirectory
    ? pathWithTilde.replace(/^~(?=$|\/|\\)/, homeDirectory)
    : pathWithTilde;
}

// Get rootPath based on multi-workspace API, start at document location and
// move up until we find a directory with ansible.cfg
export function getRootPath(editorDocumentUri: vscode.Uri): string | undefined {
  let currentDir = path.dirname(editorDocumentUri.fsPath);

  // Determine the workspace folder if possible
  const workspaceFolder =
    typeof vscode.workspace.getWorkspaceFolder === "function"
      ? vscode.workspace.getWorkspaceFolder(editorDocumentUri)?.uri.fsPath
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  while (currentDir && currentDir !== workspaceFolder) {
    if (fs.existsSync(path.join(currentDir, "ansible.cfg"))) {
      console.log(`Ansible root directory found: ${currentDir}`);
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Stop if we reach the filesystem root
    }
    currentDir = parentDir;
  }

  console.log(
    `No ansible.cfg found, using workspace folder: ${workspaceFolder}`,
  );
  return workspaceFolder;
}

export type AnsibleVaultConfig = {
  path: string;
  defaults: {
    vault_identity_list: string | undefined;
    vault_password_file: string | undefined;
  };
};

export async function scanAnsibleCfg(
  rootPath: string | undefined = undefined,
): Promise<AnsibleVaultConfig | undefined> {
  /*
   * Reading order (based on the documentation: https://docs.ansible.com/ansible/latest/reference_appendices/config.html#ansible-configuration-settings):
   * 1) ANSIBLE_CONFIG
   * 2) ansible.cfg (in root path)
   * 3) ~/.ansible.cfg
   * 4) /etc/ansible/ansible.cfg
   */
  const cfgFiles = ["~/.ansible.cfg", "/etc/ansible/ansible.cfg"];

  if (rootPath) {
    cfgFiles.unshift(`${rootPath}/ansible.cfg`);
  }

  if (process.env.ANSIBLE_CONFIG) {
    cfgFiles.unshift(process.env.ANSIBLE_CONFIG);
  }

  const cfgs = await Promise.all(
    cfgFiles
      .map((cf) => untildify(cf))
      .map(async (cp) => await getValueByCfg(cp)),
  ).catch(() => undefined);
  const cfg = cfgs?.find(
    (c) =>
      !!c?.defaults.vault_identity_list || !!c?.defaults.vault_password_file,
  );
  console.log(
    typeof cfg != "undefined"
      ? `Found 'defaults.vault_identity_list' within '${cfg.path}'`
      : "Found no 'defaults.vault_identity_list' within config files",
  );

  return cfg;
}

export async function getValueByCfg(
  path: string,
): Promise<AnsibleVaultConfig | undefined> {
  console.log(`Reading '${path}'...`);

  try {
    await fs.promises.access(path, fs.constants.R_OK);
  } catch {
    return undefined;
  }

  const parsedConfig = ini.parse(await fs.promises.readFile(path, "utf-8"));
  const vault_identity_list = parsedConfig.defaults?.vault_identity_list;
  const vault_password_file = parsedConfig.defaults?.vault_password_file;

  if (!vault_identity_list && !vault_password_file) {
    return undefined;
  }

  return {
    path: path,
    defaults: { vault_identity_list, vault_password_file },
  } as AnsibleVaultConfig;
}

export async function getAnsibleCfg(
  path: string | undefined,
): Promise<AnsibleVaultConfig | undefined> {
  if (process.env.ANSIBLE_VAULT_IDENTITY_LIST) {
    return {
      path: "ANSIBLE_VAULT_IDENTITY_LIST",
      defaults: {
        vault_identity_list: process.env.ANSIBLE_VAULT_IDENTITY_LIST,
        vault_password_file: undefined,
      },
    };
  }
  return scanAnsibleCfg(path);
}
