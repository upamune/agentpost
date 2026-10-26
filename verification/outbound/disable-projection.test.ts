import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[8];
test(name, replay);
