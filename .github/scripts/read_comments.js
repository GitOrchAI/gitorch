import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function run() {
  try {
    const [owner, repo] = "loureng/gitorch".split("/");
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: 182,
    });
    console.log(JSON.stringify(comments, null, 2));

    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: 182,
    });
    console.log(JSON.stringify(reviews, null, 2));
  } catch (error) {
    console.error(error);
  }
}

run();
