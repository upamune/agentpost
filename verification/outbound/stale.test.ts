import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[2];
test(name, replay);
