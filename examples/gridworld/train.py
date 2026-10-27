"""Tabular Q-learning on a small gridworld, logged to seaglass with the views in
./views: an episode renderer and a view of the value map.

    seaglass serve --dir runs          # in one terminal
    python examples/gridworld/train.py  # in another, then open the URL it prints

Every epoch plays a batch of episodes and logs their returns; every few epochs it
logs a greedy episode (raw arrays, which views/episode.js plays) and the value map
(which views/values.js draws).
"""

import argparse
import time
from pathlib import Path

import numpy as np

from seaglass import Arrays, Monitor

# '#' wall, 'S' start, 'G' goal
GRID = [
    ".......",
    ".#####.",
    ".#...#.",
    ".#.#.#.",
    "...#.#.",
    "####.#.",
    "S....#G",
]
# up, right, down, left
MOVES = np.array([[-1, 0], [0, 1], [1, 0], [0, -1]])
STEP_REWARD, GOAL_REWARD, MAX_STEPS = -0.01, 1.0, 60


def parse(grid: list[str]) -> tuple[np.ndarray, tuple[int, int], tuple[int, int]]:
    walls = np.array([[c == "#" for c in row] for row in grid])

    def find(ch: str) -> tuple[int, int]:
        return next((r, row.index(ch)) for r, row in enumerate(grid) if ch in row)

    return walls, find("S"), find("G")


def play(q, walls, start, goal, epsilon, rng, learn=None):
    """One episode; returns the cells visited, the rewards, and the TD errors if
    learning with (alpha, gamma)."""
    h, w = walls.shape
    pos, path, rewards, errors = start, [start], [], []
    for _ in range(MAX_STEPS):
        r, c = pos
        a = rng.integers(4) if rng.random() < epsilon else int(np.argmax(q[r, c]))
        nr, nc = r + MOVES[a][0], c + MOVES[a][1]
        if not (0 <= nr < h and 0 <= nc < w) or walls[nr, nc]:
            nr, nc = r, c
        done = (nr, nc) == goal
        reward = GOAL_REWARD if done else STEP_REWARD
        if learn:
            alpha, gamma = learn
            target = reward + (0 if done else gamma * q[nr, nc].max())
            errors.append(target - q[r, c, a])
            q[r, c, a] += alpha * errors[-1]
        pos = (nr, nc)
        path.append(pos)
        rewards.append(reward)
        if done:
            break
    return np.array(path), np.array(rewards), errors


def describe(monitor: Monitor, config: dict) -> None:
    """Say what the run logs, so whoever reads it can tell without asking."""
    eps = config["epsilon"]
    monitor.describe(
        "*_return",
        "The mean, best and worst return of the epoch's episodes, undiscounted: "
        f"{GOAL_REWARD:+g} for reaching the goal, {STEP_REWARD:g} for every step.\n"
        "The shorter the path to the goal, the higher the return.",
        better="higher",
    )
    monitor.describe("mean_return", headline=True)
    monitor.describe(
        "success",
        "The share of the epoch's episodes that reached the goal within "
        f"{MAX_STEPS} steps.",
        better="higher",
        headline=True,
    )
    monitor.describe(
        "episode_length",
        "Steps per episode, averaged over the epoch. An episode that never reaches "
        f"the goal is cut off at {MAX_STEPS}.",
        unit="steps",
        better="lower",
    )
    monitor.describe(
        "td_error",
        "The mean absolute TD error of the epoch's Q-learning updates. It falls as "
        "the values settle, but rises for a while each time the agent finds a "
        "better path.",
        log=True,
        better="lower",
    )
    monitor.describe(
        "epsilon",
        f"The chance of a random move, decayed linearly from {eps['start']:g} to "
        f"{eps['end']:g} over the first {eps['decay_epochs']} epochs.",
    )
    monitor.describe(
        "episode",
        "A greedy episode (epsilon 0), played every 10 epochs: the path the agent "
        "takes with what it has learned so far.",
    )
    monitor.describe(
        "values",
        "The value of each cell (the best of its Q-values) and the move the agent "
        "would make there, every 10 epochs.",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Q-learning on a gridworld, logged to seaglass."
    )
    parser.add_argument("--url", help="the seaglass server (default: $SEAGLASS_URL)")
    parser.add_argument("--epochs", type=int, default=150)
    parser.add_argument("--episodes", type=int, default=20, help="per epoch")
    parser.add_argument("--delay", type=float, default=0.05, help="seconds per epoch")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    config = {
        "grid": GRID,
        "alpha": 0.5,
        "gamma": 0.97,
        "epsilon": {"start": 1.0, "end": 0.05, "decay_epochs": 100},
        "episodes_per_epoch": args.episodes,
        "seed": args.seed,
    }
    walls, start, goal = parse(GRID)
    rng = np.random.default_rng(args.seed)
    q = np.zeros((*walls.shape, 4))
    views = Path(__file__).parent / "views"

    with Monitor(args.url, project="gridworld", views=views) as monitor:
        describe(monitor, config)
        monitor.start(config, total=args.epochs - 1)
        for epoch in range(args.epochs):
            monitor.activity(f"epoch {epoch}: training")
            eps = config["epsilon"]
            frac = min(1.0, epoch / eps["decay_epochs"])
            epsilon = eps["start"] + frac * (eps["end"] - eps["start"])
            returns, lengths, errors, wins = [], [], [], 0
            for _ in range(args.episodes):
                path, rewards, err = play(
                    q,
                    walls,
                    start,
                    goal,
                    epsilon,
                    rng,
                    (config["alpha"], config["gamma"]),
                )
                returns.append(rewards.sum())
                lengths.append(len(rewards))
                errors += err
                wins += tuple(path[-1]) == goal
            monitor.log(
                epoch,
                {
                    "mean_return": np.mean(returns),
                    "min_return": np.min(returns),
                    "max_return": np.max(returns),
                    "success": wins / args.episodes,
                    "episode_length": np.mean(lengths),
                    "td_error": np.mean(np.abs(errors)),
                    "epsilon": epsilon,
                },
            )
            if epoch % 10 == 0 or epoch == args.epochs - 1:
                monitor.activity(f"epoch {epoch}: greedy episode")
                path, rewards, _ = play(q, walls, start, goal, 0.0, rng)
                monitor.log(
                    epoch,
                    {
                        # the raw data; views/episode.js draws it
                        "episode": Arrays(
                            "gridworld/episode",
                            walls=walls,
                            path=path.astype(np.int32),
                            rewards=rewards.astype(np.float32),
                            goal=np.array(goal, np.int32),
                            attrs={"epsilon": 0.0},
                        ),
                        "values": Arrays(
                            "gridworld/values",
                            walls=walls,
                            value=q.max(-1).astype(np.float32),
                            policy=q.argmax(-1).astype(np.int8),
                            goal=np.array(goal, np.int32),
                        ),
                    },
                )
            time.sleep(args.delay)


if __name__ == "__main__":
    main()
