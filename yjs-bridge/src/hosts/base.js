// Host adapter: everything the bridge needs from the place where the repository lives.
//
//   kind, owner, repo, slug   identity of the repository (slug = owner/repo, used in URLs)
//   url                       what the service's bare clone has as its remote
//   gitEnv()                  environment for the git commands that talk to the host
//   fetch(git, branch)        bring the branch into the clone, return its commit (reader)
//   push(git, commit, ref, {author})
//                             non-forced write of one commit to one ref -> {ok, reason} (writer);
//                             author is the person whose text it is, for a host that pushes as them
//   watch({onMove, ...})      start whatever tells the bridge that main moved (hook, webhook);
//                             polling is done by the bridge itself and always runs as well
//   unwatch()
//
// fetch and push go through the git command here. A host that should be written through an API
// (GitHub contents API, an installation token over HTTPS) overrides push/fetch and nothing else
// changes.
export class GitHost {
  constructor({ kind, owner, repo, url }) {
    this.kind = kind;
    this.owner = owner;
    this.repo = repo;
    this.url = url;
  }

  get slug() { return `${this.owner}/${this.repo}`; }

  gitEnv() { return {}; }

  fetch(git, branch) { return git.fetch(branch); }

  push(git, commit, ref) { return git.push(commit, ref); }

  async watch() { return []; }

  async unwatch() {}
}
