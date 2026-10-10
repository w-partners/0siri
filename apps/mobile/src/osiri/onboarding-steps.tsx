// 온보딩 2/3 · 3/3 단계 조각 — 화면 1(auth.tsx 가입 직후)과 화면 6(store.tsx 구독 직후)이 같이 쓴다.
// 두 화면이 서로를 import 하지 않도록 여기에 둔다.
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Profile } from "../../../server/src/osiri/accounts.ts";
import type { MuseApi } from "../api";
import { Button, ErrorNotice, Field, s, useAction } from "../ui";

/** 온보딩 3단계: 1/3 계정 만들기 ✓ → 2/3 사무소 프로필 → 3/3 첫 목표 한 줄 */
export const ONBOARDING_STEPS = [
  { title: "계정 만들기", body: "초대 링크 또는 초대 대기 신청 · 전화번호 · 비밀번호" },
  { title: "사무소 프로필", body: "이름 · 전문 분야 · 지역" },
  { title: "첫 목표 한 줄", body: "예: 상속 분야 GEO 선점" },
] as const;
export const PROFILE_STEP = 1;
export const GOAL_STEP = 2;
/** 단계 제목 — 스토어의 구독 뒤 온보딩(화면 6)이 같은 문구를 쓴다 */
export const ONBOARDING_TITLES = {
  profile: ONBOARDING_STEPS[PROFILE_STEP].title,
  goal: ONBOARDING_STEPS[GOAL_STEP].title,
};
export const profileComplete = (profile: Profile) =>
  !!(profile.displayName && profile.specialty && profile.region);

const text = {
  retry: "다시 시도",
  displayName: "이름",
  displayNamePlaceholder: "홍길동 법률사무소",
  specialty: "전문 분야",
  specialtyPlaceholder: "예: 상속 · 가사",
  region: "지역",
  regionPlaceholder: "예: 서울 서초",
  profileRequired: "이름 · 전문 분야 · 지역을 모두 입력해 주세요",
  goal: "첫 목표",
  goalPlaceholder: "상속 분야 GEO 선점",
  goalHint: "한 줄이면 됩니다. 제안 상태로 저장되고, 목표 화면에서 승인하면 시작합니다.",
  goalRequired: "첫 목표를 한 줄 적어 주세요",
  next: "저장하고 다음",
  saveGoal: "목표 저장",
};

/** 2/3 사무소 프로필 — 저장해 둔 값을 채워 보이고 `PATCH /me/profile` 로 저장한다. */
export function ProfileStep({
  api,
  profile,
  onSaved,
}: {
  api: MuseApi;
  profile: Profile;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [specialty, setSpecialty] = useState(profile.specialty ?? "");
  const [region, setRegion] = useState(profile.region ?? "");
  const [invalid, setInvalid] = useState("");
  const act = useAction();
  const save = () => {
    const body = {
      displayName: displayName.trim(),
      specialty: specialty.trim(),
      region: region.trim(),
    };
    if (!body.displayName || !body.specialty || !body.region)
      return setInvalid(text.profileRequired);
    setInvalid("");
    void act.run(async () => {
      await api.request("/api/me/profile", body, "PATCH");
      onSaved();
    });
  };
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={invalid || act.error} />
      <View>
        <Field
          label={text.displayName}
          value={displayName}
          onChangeText={setDisplayName}
          placeholder={text.displayNamePlaceholder}
        />
        <Field
          label={text.specialty}
          value={specialty}
          onChangeText={setSpecialty}
          placeholder={text.specialtyPlaceholder}
        />
        <Field
          label={text.region}
          value={region}
          onChangeText={setRegion}
          placeholder={text.regionPlaceholder}
          onSubmitEditing={save}
        />
      </View>
      <Button primary busy={act.busy} onPress={save}>
        {act.error ? text.retry : text.next}
      </Button>
    </View>
  );
}

/** 3/3 첫 목표 한 줄 → `POST /goals`(제안 상태). 어느 방의 목표인지는 부르는 쪽이 정한다(개인 방 / 방금 구독한 팀 방). */
export function GoalStep({
  api,
  roomId,
  after,
  onSaved,
}: {
  api: MuseApi;
  roomId: () => Promise<string> | string;
  /** 목표 저장 뒤에 이어서 할 일. 여기서 실패하면 [다시 시도] 가 목표를 또 만들지 않고 이 일부터 잇는다 */
  after?: () => Promise<void>;
  onSaved: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [invalid, setInvalid] = useState("");
  const act = useAction();
  const goalSaved = useRef(false);
  const save = () => {
    const title = goal.trim();
    if (!title) return setInvalid(text.goalRequired);
    setInvalid("");
    void act.run(async () => {
      if (!goalSaved.current) {
        await api.request("/api/goals", { roomId: await roomId(), title });
        goalSaved.current = true;
      }
      await after?.();
      onSaved();
    });
  };
  return (
    <View style={{ gap: 12 }}>
      <ErrorNotice error={invalid || act.error} />
      <View>
        <Field
          label={text.goal}
          value={goal}
          onChangeText={setGoal}
          placeholder={text.goalPlaceholder}
          onSubmitEditing={save}
        />
        <Text style={[s.small, { marginTop: -8 }]}>{text.goalHint}</Text>
      </View>
      <Button primary busy={act.busy} onPress={save}>
        {act.error ? text.retry : text.saveGoal}
      </Button>
    </View>
  );
}
