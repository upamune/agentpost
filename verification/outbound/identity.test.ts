import { test } from "vitest";
import { cases } from "./replays";

const [name, replay] = cases[5];
test(name, replay);
