import * as CH from "../ipc-channels";
import {
  listPullRequests,
  listIssues,
  getIssue,
  createPullRequest,
  getCiStatus,
  getPullRequestContext,
} from "../github";
import type {
  GitHubCreatePrArgs,
  GitHubGetIssueArgs,
  GitHubGetPrContextArgs,
  GitHubListPrsArgs,
  GitHubListIssuesArgs,
  GitHubGetCiStatusArgs,
} from "../../src/types/index";
import { handle } from "./handle";

export function registerGitHubHandlers(): void {
  handle(CH.GITHUB_LIST_PRS, (_event, args: GitHubListPrsArgs) => listPullRequests(args));
  handle(CH.GITHUB_LIST_ISSUES, (_event, args: GitHubListIssuesArgs) => listIssues(args));
  handle(CH.GITHUB_GET_ISSUE, (_event, args: GitHubGetIssueArgs) => getIssue(args));
  handle(CH.GITHUB_CREATE_PR, (_event, args: GitHubCreatePrArgs) => createPullRequest(args));
  handle(CH.GITHUB_GET_CI_STATUS, (_event, args: GitHubGetCiStatusArgs) => getCiStatus(args));
  handle(CH.GITHUB_GET_PR_CONTEXT, (_event, args: GitHubGetPrContextArgs) => getPullRequestContext(args));
}
