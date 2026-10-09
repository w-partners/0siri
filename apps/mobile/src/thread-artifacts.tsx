import { useEffect, useState } from "react";
import { View } from "react-native";
import type { AgentArtifact, AgentTask } from "../../../packages/domain/src/agent";
import { ArtifactCard, TaskCard } from "./agent-ui";
import { Button, ErrorNotice } from "./ui";
import { useWorkspace } from "./workspace";

/** Hydrates task-linked artifacts by ID on replay; signed URLs are never stored in messages. */
export function TaskThreadCard({ task }: { task: AgentTask }) {
  const { api } = useWorkspace();
  const [detail, setDetail] = useState<{ artifacts: AgentArtifact[] }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void api
      .request<{ artifacts: AgentArtifact[] }>(`/api/agent/tasks/${task.id}`)
      .then((result) => {
        if (active) {
          setDetail(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, task.id, task.updatedAt, attempt]);
  return (
    <View style={{ gap: 12 }}>
      <TaskCard task={task} compact />
      {detail?.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
      <ErrorNotice error={error} />
      {!!error && (
        <Button small onPress={() => setAttempt((value) => value + 1)}>
          Reload task results
        </Button>
      )}
    </View>
  );
}
