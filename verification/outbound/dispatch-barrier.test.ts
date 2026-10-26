import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[9];
test(name, replay);
