/*
Copyright (c) 2018-2019 Uber Technologies, Inc.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/

/* eslint-disable flowtype/require-valid-file-annotation */
/* eslint-env node */

const {execSync} = require('child_process');
const Octokit = require('@octokit/rest');

// Load environment variables
const {
  GITHUB_BOT_AUTH_TOKEN,
  GITHUB_BOT_NAME,
  GITHUB_BOT_EMAIL,
  BUILDKITE_BRANCH,
  BUILDKITE_COMMIT,
  BUILDKITE_PULL_REQUEST,
  BUILDKITE_PULL_REQUEST_REPO,
} = process.env;

// Derive some useful constants
const SNAPSHOT_BRANCH = `${BUILDKITE_BRANCH}--vrt`;
const ORIGINAL_PULL_REQUEST_OWNER = getOwnerFromRepoURL(
  BUILDKITE_PULL_REQUEST_REPO,
);
const ORIGINAL_COMMIT_SHORT_HASH = BUILDKITE_COMMIT.substring(0, 7); // First 7 chars makes it linkable in GitHub

// Prepare GitHub API helper
const octokit = Octokit({
  auth: GITHUB_BOT_AUTH_TOKEN,
});

process.on('unhandledRejection', function(err) {
  log(`The job has failed, but it is not a failure.`);
  throw err;
});

main();

async function main() {
  if (!buildIsValid()) return;
  installChromium();
  if (buildWasTriggeredByPR()) {
    configureGit();
    runTestsWithUpdates();
    await updateGitHub();
  } else {
    runTestsWithNoUpdates();
  }
}

function buildIsValid() {
  if (BUILDKITE_BRANCH.endsWith(`--vrt`)) {
    log(`This build was somehow triggered from a snapshot update branch!`);
    log(`This should not happen! Check the logs! Exiting early.`);
    return false;
  } else {
    return true;
  }
}

function installChromium() {
  log(`Add Puppeteer package to trigger Chromium installation script.`);
  execSync(`yarn add puppeteer`);
}

function buildWasTriggeredByPR() {
  // This env variable can be a PR number ("1234") or "false"
  const result = BUILDKITE_PULL_REQUEST > 0;
  if (result) {
    log(`This build was triggerd by a PR.`);
  } else {
    log(`This build was not triggered by a PR.`);
  }
  return result;
}

function configureGit() {
  log(`Configuring git to allow for pushing new commits & branches.`);
  execSync(
    `git config --global url."https://${GITHUB_BOT_AUTH_TOKEN}:@github.com/".insteadOf "https://github.com/"`,
  );
  execSync(`git config --global user.email ${GITHUB_BOT_EMAIL}`);
  execSync(`git config --global user.name ${GITHUB_BOT_NAME}`);
}

function runTestsWithUpdates() {
  log(`Running visual snapshot tests with updates.`);
  execSync(`yarn vrt -u`, {stdio: 'inherit'});
}

function runTestsWithNoUpdates() {
  log(`Running visual snapshot tests with no updates.`);
  execSync(`yarn vrt`, {stdio: 'inherit'});
}

async function updateGitHub() {
  const snapshotPullRequest = await getSnapshotPullRequest();
  if (someSnapshotsWereUpdated()) {
    pushChangesToGitHub();
    await updatePullRequests(snapshotPullRequest);
    throw new Error(
      `Generated snapshots do not match currently checked in snapshots.`,
    );
  } else {
    await removeSnapshotsWorkFromGitHub(snapshotPullRequest);
  }
}

async function removeSnapshotsWorkFromGitHub(snapshotPullRequest) {
  if (snapshotPullRequest) {
    await closeSnapshotPullRequest(snapshotPullRequest.number);
    await removeSnapshotBranchFromGitHub();
  } else {
    log(`Nothing to clean up.`);
  }
}

async function updatePullRequests(snapshotPullRequest) {
  if (snapshotPullRequest) {
    log(
      `The existing snapshot PR has been updated with the latest snapshot diffs.`,
    );
    await addCommentToOriginalPullRequest(snapshotPullRequest.number);
  } else {
    const newSnapshotPullRequest = await createSnapshotPullRequest();
    await addLabelsToSnapshotPullRequest(newSnapshotPullRequest.number);
    await addCommentToOriginalPullRequest(newSnapshotPullRequest.number);
    await addOriginalAuthorAsReviewer(newSnapshotPullRequest.number);
    log(
      `Snapshots on \`${SNAPSHOT_BRANCH}\` must be merged into \`${BUILDKITE_BRANCH}\` before it can be merged into \`master\`.`,
    );
  }
}

async function addOriginalAuthorAsReviewer(newSnapshotPullRequestNumber) {
  try {
    const originalPullRequest = await octokit.pulls.get({
      owner: `uber`,
      repo: `baseweb`,
      pull_number: BUILDKITE_PULL_REQUEST,
    });
    const author = originalPullRequest.data.user;
    await octokit.pulls.createReviewRequest({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      pull_number: newSnapshotPullRequestNumber,
      reviewers: [author.login],
    });
    log(`Requested review from \`${author.login}\` on new snapshot PR.`);
  } catch (er) {
    log(
      `There was an error adding the original PR author as a reviewer for the new snapshot PR.`,
    );
  }
}

async function removeSnapshotBranchFromGitHub() {
  try {
    await octokit.git.deleteRef({
      owner: `uber`,
      repo: `baseweb`,
      ref: `heads/${SNAPSHOT_BRANCH}`,
    });
    log(`Removed the snapshot branch from GitHub`);
  } catch (er) {
    log(`There was an error removing the snapshot branch from GitHub.`);
  }
}

async function closeSnapshotPullRequest(snapshotPullRequestNumber) {
  await notifySnapshotPullRequestOfClosure(snapshotPullRequestNumber);
  try {
    await octokit.pulls.update({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      pull_number: snapshotPullRequestNumber,
      state: 'closed',
    });
    log(`Closed the existing snapshot PR.`);
  } catch (er) {
    log(`There was an error closing the existing snapshot PR.`);
  }
  await notifyOriginalPullRequestOfClosure(snapshotPullRequestNumber);
}

async function notifyOriginalPullRequestOfClosure(snapshotPullRequestNumber) {
  try {
    await octokit.issues.createComment({
      owner: `uber`,
      repo: `baseweb`,
      issue_number: BUILDKITE_PULL_REQUEST,
      body:
        `Visual changes have been resolved. #${snapshotPullRequestNumber} has been closed. ` +
        `A new snapshot branch will be created and a new PR will be opened if future commits on \`${BUILDKITE_BRANCH}\` trigger visual changes.`,
    });
    log(
      `Posted a comment on original PR about closure of existing snapshot PR.`,
    );
  } catch (er) {
    log(
      `There was an error commenting on the original PR about snapshot resolution.`,
    );
  }
}

async function notifySnapshotPullRequestOfClosure(snapshotPullRequestNumber) {
  try {
    await octokit.issues.createComment({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      issue_number: snapshotPullRequestNumber,
      body:
        `Visual changes have been resolved. ` +
        `This PR will be closed and \`${SNAPSHOT_BRANCH}\` will be deleted. ` +
        `A new snapshot branch will be created and a new PR will be opened if future commits on \`${BUILDKITE_BRANCH}\` trigger visual changes.`,
    });
    log(`Posted a comment on snapshot PR about visual resolution and closure.`);
  } catch (er) {
    log(
      `There was an error commenting on the existing snapshot PR about snapshot resolution.`,
    );
  }
}

async function addLabelsToSnapshotPullRequest(newPullRequestNumber) {
  try {
    await octokit.issues.addLabels({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      issue_number: newPullRequestNumber,
      labels: [`greenkeeping`, `visual snapshot updates`],
    });
    log(`Added labels to new snapshot PR.`);
  } catch (er) {
    log(`There was an error adding labels to new snapshot PR.`);
  }
}

async function addCommentToOriginalPullRequest(newPullRequestNumber) {
  try {
    const comment = await octokit.issues.createComment({
      owner: `uber`,
      repo: `baseweb`,
      issue_number: BUILDKITE_PULL_REQUEST,
      body:
        `Visual changes were detected on this branch. ` +
        `Please review the following PR containing updated snapshots: #${newPullRequestNumber}`,
    });
    log(
      `Posted a comment linking to snapshot PR on original PR: ${comment.data.html_url}`,
    );
  } catch (er) {
    log(`Error creating comment on original PR.`);
  }
}

async function createSnapshotPullRequest() {
  try {
    const pullRequest = await octokit.pulls.create({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      title: `test(vrt): update visual snapshots for ${BUILDKITE_BRANCH} [skip ci]`,
      head: SNAPSHOT_BRANCH,
      base: BUILDKITE_BRANCH,
      body:
        `This PR was generated based on visual changes detected in #${BUILDKITE_PULL_REQUEST}. ` +
        `Please verify that the updated snapshots look correct before merging this PR into \`${BUILDKITE_BRANCH}\`.`,
    });
    log(`Created a new snapshot PR: ${pullRequest.data.html_url}`);
    return pullRequest.data;
  } catch (er) {
    log(`There was an error creating a new snapshot PR.`);
  }
}

async function getSnapshotPullRequest() {
  try {
    const pullRequests = await octokit.pulls.list({
      owner: ORIGINAL_PULL_REQUEST_OWNER,
      repo: `baseweb`,
      head: `uber:${SNAPSHOT_BRANCH}`,
    });
    const pullRequest = pullRequests.data[0]; // should only ever be one PR
    if (pullRequest) {
      log(`An existing snapshot PR was found.`);
      return pullRequest;
    } else {
      log(`No existing snapshot PR was found.`);
      return null;
    }
  } catch (er) {
    log(
      `There was an error fetching existing PRs so could not find an existing snapshot PR.`,
    );
  }
}

function pushChangesToGitHub() {
  log(
    `Creating a new snapshot branch: ${SNAPSHOT_BRANCH}. ` +
      `This will overwrite any existing snapshot branch.`,
  );
  execSync(`git checkout -b ${SNAPSHOT_BRANCH}`);
  execSync(`git add vrt/__image_snapshots__/`);
  log(`Commiting updated snapshots to ${SNAPSHOT_BRANCH}.`);
  execSync(
    `git commit -m "test(vrt): update visual snapshots for ${ORIGINAL_COMMIT_SHORT_HASH} [skip ci]"`,
  );
  log(`Force pushing updated snapshot branch to GitHub.`);
  execSync(`git push --force origin ${SNAPSHOT_BRANCH}`);
}

function someSnapshotsWereUpdated() {
  const stdout = execSync(`git status --porcelain`).toString();
  const changedFiles = stdout.split(`\n`);
  const updatedSnapshots = changedFiles.filter(s =>
    s.match(/vrt\/__image_snapshots__\//),
  );
  const result = updatedSnapshots.length > 0;
  if (result) {
    log(`Some snapshots were updated.`);
  } else {
    log(`No snapshots were updated.`);
  }
  return result;
}

// Extract basweb fork owner from a GitHub repository url
function getOwnerFromRepoURL(url) {
  const matches = url.match(/https:\/\/github\.com\/(.*)\/baseweb\.git/);
  return matches && matches[1] ? matches[1] : `uber`;
}

function log(message) {
  console.log(`❖ VRT: ${message}`);
}
