# Sokoban solver — per-room push-optimal A*

## What it does

`main.ts` reads the five levels of a set from `$MAKEFUN_INPUT_DIR/<id>/level.txt`
(or `/input/<id>/level.txt`) and writes the player's moves to
`$MAKEFUN_OUTPUT_DIR/<id>/solution.txt` (or `/output/<id>/solution.txt`),
one `solution.txt` per instance. Moves are `u`/`d`/`l`/`r`, one letter a step;
the checker counts the steps that move a box as pushes.

## How it searches

A level is a 1-wide hallway (the row the player starts on) with one to four
rooms hanging off it, one door each. A box pushed through a door into the
hallway could never be pushed back, so every box stays in its room and the
level's push-optimal count is the sum of the rooms' optima. The solver
therefore splits the level into rooms — the floor components left when the
hallway row is cut away — and solves each room on its own, walking the player
between rooms along the hallway.

Each room is solved with A* over pushes:

- **State:** the sorted box positions plus the player's position.
- **Moves:** a push is possible when the player can walk (flood fill, boxes
  as obstacles) to the square behind a box and the square beyond it is free.
  The player may stand in the hallway to push a box that sits in the doorway.
- **Heuristic:** the cheapest assignment of boxes to goals, summed over
  precomputed shortest-path distances inside the room. One push moves one
  box one cell, so this is admissible and consistent — A* is push-optimal.
- **Pruning:** precomputed dead squares (a least fixpoint: a cell is dead
  when every push from it is impossible or lands on a dead cell), 2x2 blocks
  of boxes/walls holding a box off its goal, and a transposition table.
- **Goal:** every box on a goal and the player able to walk back out to the
  hallway. The move string is rebuilt by walking the player to each push
  (shortest path) and finally out through the door.

## Determinism and budget

The search is budgeted by node count, never by the wall clock: 250,000
expansions per room and 600,000 for the whole run, so a pathological room
fails that instance instead of timing out the run. Iteration orders are
fixed, heap ties break on a sequence number, and the program never reads the
clock, so two executions write byte-identical answers.

## Results on the practice set

All five instances solved at exactly their push-optimal counts
(13 / 16 / 29 / 47 / 60 pushes) — score 1,000,000, in about half a second.
The house baseline (plain-astar) scores 200,000 on the same set.
