---
'@aspiralabs/build-feature': minor
'@aspiralabs/groomer': minor
---

`--autonomous` (KIT-24): `/aspira-build-feature <ID> --local --autonomous` skips the human gates. The groomer step runs with `--autonomous`: every open question is taken as its recommended option, the exit-criterion ones (problem, who, done) included, no chat round is printed, and the run confirms itself once every branch is visited (the Idea summary is still written and the card still moves Grooming → Shortlist → Ready: Idea). A build-feature `ask` whose quoted decision carries a recommended option is answered with it and recorded under asked. The flag is recorded on the run, carried by the resume command and named in the Build Summary's mode line. `--autonomous` without `--local` is refused. The merge stays human.
